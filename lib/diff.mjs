// Monta as colunas antes/depois de um arquivo alterado. Usa `git diff` com a margem de contexto
// pedida em volta de cada hunk, em vez de reimplementar um algoritmo de diff.
//
// Três coisas que este arquivo não faz do jeito padrão, cada uma medida no lugar onde vale:
// o algoritmo é o `histogram` (ver ALGORITMO), o conteúdo de um blob vem de um `git cat-file
// --batch` de vida longa (ver CatFile) e o que mudou DENTRO da linha vem de um segundo diff em
// `--word-diff=porcelain` (ver `_aplicarTrechos`).
//
// Consumido pelo servidor (JSON) e pelo ferramentas/diff-visao.mjs (HTML estático).

import { execFileSync, spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aplicarEnv } from './env.mjs';

// O `.env` é lido AQUI, e não por quem importa: imports avaliam antes do corpo do módulo, então o
// `aplicarEnv()` do `server.mjs` rodava depois desta linha e o `QUALIDADE_WORKSPACE` do arquivo não
// tinha efeito nenhum — justamente a chave que o portão da primeira abertura grava.
aplicarEnv();

// O workspace é a pasta que CONTÉM este projeto — é onde os repos vizinhos estão. `QUALIDADE_WORKSPACE`
// sobrescreve para quem quiser apontar para outro lugar. Sem isso, um caminho absoluto no código faz a
// ferramenta só funcionar na máquina de quem escreveu.
// lib/diff.mjs -> lib -> qualidade -> workspace: três níveis, não dois.
export const WORKSPACE = process.env.QUALIDADE_WORKSPACE
    || dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CONTEXTO_TOTAL = '-U100000';
const MARGEM_PADRAO = 6;
const CANDIDATAS_BASE = ['origin/desenv', 'origin/stage', 'origin/main', 'origin/master'];
// O myers padrão fecha o diff mais curto e para isso corta bloco movido ao meio, casando `}` e
// linha em branco de trechos que não têm relação. Medido em commits reais deste workspace, contando
// REGIÕES de alteração (corrida de linhas -/+ cercada por contexto), que é o que a tela desenha:
// contas-service e96be7c (UND-1991) 220 → 195, crohc-view 73f39643c (UND-1722) 70 → 59,
// workflow-manager dee7701 218 → 205. Mesmo nº de hunks, menos alteração picada no meio do igual.
const ALGORITMO = '--diff-algorithm=histogram';
// Espera pelo PRIMEIRO byte de uma resposta, e pelos seguintes. O primeiro é curto porque é ele
// que paga o filho morto: a espera é síncrona, e `exitCode` não é atualizado enquanto o event loop
// está parado — medido, um `git cat-file` morto por SIGKILL continua com `exitCode: null`. Depois
// que os bytes começaram, cada leitura renova o prazo longo: blob grande chega em pedaços.
const PRIMEIRA_RESPOSTA = 500;
const ESPERA_RESPOSTA = 5000;
const TETO_DO_PROCESSO = 64 * 1024 * 1024;
// Arquivo inteiro reescrito não tem "dentro da linha" para mostrar, e o word-diff dele sai maior
// que o próprio arquivo.
const PARES_PARA_TRECHOS = 400;
// O word-diff padrão NÃO devolve a mudança de espaço em branco, e sem o espaço a linha
// reconstruída não bate com a do diff de linha e é recusada: 169 pares reconstruídos com o padrão
// contra 193 com este regex, nos mesmos 4 commits. Cada corrida de não-espaço e cada espaço viram
// um pedaço; corrida inteira em vez de caractere não corta char multibyte, e o `\n` fica fora
// porque o git proíbe que o regex o cruze.
const PALAVRAS = '--word-diff-regex=[^[:space:]]+|[[:blank:]]';

export class CatFile {
    static abertos = new Map();
    static saidaRegistrada = false;
    // Contador no nome do temporário: dois repos abertos no MESMO milissegundo pegariam o mesmo
    // arquivo, e a resposta de um viraria a do outro.
    static quantosAbriram = 0;
    static faxina = null;
    // Teto de canais vivos, tempo sem uso que fecha um e de quanto em quanto tempo se varre. Sem os
    // dois primeiros, cada repo visitado deixava um filho parado pelo resto da vida do servidor.
    static TETO = 8;
    static INATIVIDADE = 60 * 1000;
    static INTERVALO_FAXINA = 15 * 1000;

    static de(repo) {
        let existente = CatFile.abertos.get(repo);
        if (existente) {
            // Reinserir joga o repo para o fim: `Map` itera na ordem de inserção, então o primeiro
            // da iteração é sempre o menos usado recentemente — é o que faz o teto largar o certo.
            CatFile.abertos.delete(repo);
        } else {
            existente = new CatFile(repo);
        }
        existente.usadoEm = Date.now();
        CatFile.abertos.set(repo, existente);
        CatFile._aparar();
        CatFile._agendarFaxina();
        return existente;
    }

    // Canal parado não é canal em uso: o servidor fica dias no ar e o workspace tem 51 repos.
    static expirarInativos(agora = Date.now()) {
        for (const [repo, cat] of CatFile.abertos) {
            if (agora - cat.usadoEm >= CatFile.INATIVIDADE) {
                cat.fechar();
                CatFile.abertos.delete(repo);
            }
        }
        if (!CatFile.abertos.size) {
            CatFile._pararFaxina();
        }
    }

    static fecharTodos() {
        for (const cat of CatFile.abertos.values()) {
            cat.fechar();
        }
        CatFile.abertos.clear();
        CatFile._pararFaxina();
    }

    static _aparar() {
        while (CatFile.abertos.size > CatFile.TETO) {
            const maisAntigo = CatFile.abertos.keys().next().value;
            CatFile.abertos.get(maisAntigo).fechar();
            CatFile.abertos.delete(maisAntigo);
        }
    }

    static _agendarFaxina() {
        if (CatFile.faxina) {
            return;
        }
        // `unref` obrigatório: as ferramentas de linha de comando importam este módulo e têm de
        // terminar sozinhas — timer referenciado penduraria o processo até o disparo seguinte.
        CatFile.faxina = setInterval(() => CatFile.expirarInativos(), CatFile.INTERVALO_FAXINA);
        CatFile.faxina.unref();
    }

    static _pararFaxina() {
        if (CatFile.faxina) {
            clearInterval(CatFile.faxina);
            CatFile.faxina = null;
        }
    }

    constructor(repo) {
        this.repo = repo;
        this.filho = null;
        this.fd = null;
        this.pos = 0;
        this.usadoEm = Date.now();
        // Plano B PERMANENTE deste repo: canal que não respondeu uma vez não responde na seguinte,
        // e a tela não pode ficar parada esperando de novo.
        this.desistiu = false;
        this.espera = new Int32Array(new SharedArrayBuffer(4));
    }

    // Buffer do blob, ou null quando o caminho não existe naquele ref (`<pedido> missing`), não é
    // blob (árvore, commit) ou o canal desistiu — quem chama distingue pelo `desistiu`.
    blob(ref, caminho) {
        if (this.desistiu) {
            return null;
        }
        try {
            this._garantir();
            this.filho.stdin.write(`${ref}:${caminho}\n`);
            // `missing` e árvore não casam com o formato `<oid> blob <tamanho>` e caem fora aqui,
            // com o protocolo ainda em sincronia: o que veio foi só a linha de cabeçalho.
            const cabecalho = this._cabecalho().match(/ blob (\d+)$/);
            if (!cabecalho) {
                return null;
            }
            const tamanho = Number(cabecalho[1]);
            const corpo = this._ler(tamanho + 1).subarray(0, tamanho);
            if (this.pos > TETO_DO_PROCESSO) {
                this.fechar();
            }
            return corpo;
        } catch {
            // Resposta que não chega deixa o protocolo fora de fase: matar o processo é o único
            // jeito de não devolver o arquivo de OUTRO pedido na chamada seguinte.
            this.fechar();
            this.desistiu = true;
            return null;
        }
    }

    fechar() {
        if (this.filho) {
            this.filho.stdin.destroy();
            this.filho.kill();
            this.filho = null;
        }
        if (this.fd !== null) {
            closeSync(this.fd);
            this.fd = null;
        }
    }

    // Quem diz que o filho morreu é o stdin destruído: `killed` só conta que o sinal foi enviado, e
    // `exitCode` fica em null depois de um SIGKILL.
    _garantir() {
        if (this.filho && !this.filho.stdin.destroyed
            && this.filho.exitCode === null && this.filho.signalCode === null) {
            return;
        }
        this.fechar();
        // A saída vai para arquivo temporário, não para pipe: pipe do lado do pai é não bloqueante
        // e o `readSync` nele devolve EAGAIN — e é o `readSync` que mantém esta camada síncrona.
        const caminho = join(tmpdir(),
            `qualidade-catfile-${process.pid}-${Date.now()}-${++CatFile.quantosAbriram}`);
        const fdSaida = openSync(caminho, 'w+');
        this.fd = openSync(caminho, 'r');
        // Sem nome no diretório o arquivo morre com os descritores: o servidor fica dias no ar e
        // não deixa rastro em /tmp.
        unlinkSync(caminho);
        this.filho = spawn('git', ['-C', this.repo, 'cat-file', '--batch'],
            { stdio: ['pipe', fdSaida, 'ignore'] });
        closeSync(fdSaida);
        this.pos = 0;
        // stdin fechado é EOF para o cat-file: morrendo este processo de qualquer jeito, inclusive
        // por SIGKILL, o filho termina sozinho. O `unref` é o que deixa o node sair sem esperá-lo.
        this.filho.unref();
        this.filho.stdin.unref();
        // Sem ouvinte de erro no stdin, um EPIPE (filho que morreu antes do pedido seguinte) sobe
        // como exceção não tratada e derruba o servidor inteiro.
        this.filho.on('error', () => {
            this.desistiu = true;
        });
        this.filho.stdin.on('error', () => {
            this.desistiu = true;
        });
        if (!CatFile.saidaRegistrada) {
            CatFile.saidaRegistrada = true;
            process.on('exit', () => CatFile.fecharTodos());
        }
    }

    _cabecalho() {
        const buf = Buffer.allocUnsafe(512);
        let lido = 0;
        let prazo = Date.now() + PRIMEIRA_RESPOSTA;
        for (;;) {
            const n = readSync(this.fd, buf, lido, buf.length - lido, this.pos + lido);
            lido += n;
            const fim = buf.subarray(0, lido).indexOf(10);
            if (fim >= 0) {
                this.pos += fim + 1;
                return buf.subarray(0, fim).toString('utf8');
            }
            if (lido >= buf.length || Date.now() > prazo) {
                throw new Error('cat-file: sem resposta com fim de linha');
            }
            if (n > 0) {
                prazo = Date.now() + ESPERA_RESPOSTA;
            } else {
                this._dormir();
            }
        }
    }

    _ler(quantos) {
        const buf = Buffer.allocUnsafe(quantos);
        let lido = 0;
        let prazo = Date.now() + ESPERA_RESPOSTA;
        while (lido < quantos) {
            const n = readSync(this.fd, buf, lido, quantos - lido, this.pos + lido);
            if (n === 0 && Date.now() > prazo) {
                throw new Error('cat-file: resposta incompleta');
            }
            if (n > 0) {
                prazo = Date.now() + ESPERA_RESPOSTA;
            } else {
                this._dormir();
            }
            lido += n;
        }
        this.pos += quantos;
        return buf;
    }

    // Espera de 1 ms sem devolver o controle ao event loop: quem chama está numa pilha síncrona, e
    // um `await` aqui obrigaria a tornar assíncrono o caminho inteiro do diff.
    _dormir() {
        Atomics.wait(this.espera, 0, 0, 1);
    }
}

export class Diff {
    // `ref` vazio = árvore de trabalho (repo parado na branch do chamado). Com ref, compara aquela
    // branch — senão o repo que está em outro checkout mostraria o diff do trabalho errado.
    constructor(projeto, ref = '') {
        this.projeto = projeto.startsWith('/') ? projeto : join(WORKSPACE, projeto);
        this.ref = ref;
    }

    git(...args) {
        return execFileSync('git', ['-C', this.projeto, ...args], {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore']
        });
    }

    // Todo diff deste arquivo passa por aqui para levar o mesmo algoritmo: contagem do `--numstat`
    // e desenho das colunas saindo de algoritmos diferentes dariam totais que não fecham.
    _diff(...args) {
        return this.git('diff', ALGORITMO, ...args);
    }

    // `git fetch` só atualiza refs de remoto — não toca branch local nem árvore. Disparado apenas
    // quando a ferramenta PROVA que está atrasada (PR mesclada cujo commit de merge não existe aqui),
    // nunca por precaução: seriam 50 repos a cada abertura de tela.
    buscarDoRemoto(segundos = 25) {
        execFileSync('git', ['-C', this.projeto, 'fetch', '--quiet', '--no-tags', 'origin'], {
            encoding: 'utf8', timeout: segundos * 1000, stdio: ['ignore', 'pipe', 'ignore']
        });
    }

    // Só faz sentido na árvore de trabalho (ref vazio): arquivo `??` nunca passou pelo `git add` e
    // por isso não aparece em diff nenhum. Contar aqui é o que deixa a tela dizer que ele existe.
    naoRastreados() {
        if (this.ref) {
            return [];
        }
        try {
            return this.git('status', '--porcelain', '--untracked-files=all').split('\n')
                .filter(l => l.startsWith('?? ')).map(l => l.slice(3));
        } catch {
            return [];
        }
    }

    branch() {
        return this.ref || this.git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    }

    _alvo() {
        return this.ref ? [this.ref] : [];
    }

    // A base não vem de ordem fixa de nomes: escolhe por topologia, o merge-base mais RECENTE entre
    // as candidatas que existem. Num repo real, `origin/desenv` existia mas não era a base dele: o
    // merge-base velho dava 17 arquivos de diff falso numa branch já mesclada em `main`, cujo
    // merge-base é 0 arquivos.
    resolverBase(base) {
        if (base && base !== '-') {
            return base;
        }
        const alvo = this.ref || 'HEAD';
        let melhor = null;
        for (const candidata of CANDIDATAS_BASE) {
            let mb;
            try {
                mb = this.git('merge-base', alvo, candidata).trim();
            } catch {
                continue;
            }
            if (!mb) {
                continue;
            }
            const quando = Number(this.git('show', '-s', '--format=%ct', mb).trim()) || 0;
            // Candidata que já CONTÉM a branch é a base de verdade: o trabalho foi mesclado nela.
            let contem = false;
            try {
                this.git('merge-base', '--is-ancestor', alvo, candidata);
                contem = true;
            } catch {
                contem = false;
            }
            const nota = (contem ? 1e12 : 0) + quando;
            if (!melhor || nota > melhor.nota) {
                melhor = { mb, nota, candidata, contem };
            }
        }
        if (!melhor) {
            return 'HEAD';
        }
        this.baseNome = melhor.candidata;
        // Topologia já resolve quando a branch é ancestral: o merge-base É a ponta e o diff sai
        // vazio sozinho. Filtrar aí esconderia alteração não commitada, que continua sendo trabalho.
        this.pendentes = melhor.contem ? null : this._pendentes(melhor.candidata);
        this.mesclado = melhor.contem || this.pendentes?.size === 0;
        this.comoSoube = melhor.contem ? 'topologia' : (this.mesclado ? 'conteudo' : null);
        return melhor.mb;
    }

    // Merge por squash não deixa o commit da branch como ancestral, então topologia nunca vê que o
    // trabalho entrou — 11 arquivos de diff falso no UND-1638. A pergunta que responde isso é
    // "mesclar esta branch mudaria o destino?", e quem responde é o merge-tree. `git diff` responde
    // outra coisa: inclui o que o destino ganhou de terceiros, e foi assim que 2 arquivos cujo
    // conteúdo JÁ estava em stage (por PRs de squash) apareceram como pendentes.
    _pendentes(candidata) {
        const alvo = this.ref || 'HEAD';
        let nomes = this._contribuicao(candidata, alvo);
        if (nomes === null) {
            return null;
        }
        // merge-tree só vê commit: sem isto, alteração não commitada sairia da lista em silêncio.
        if (!this.ref) {
            for (const f of this._linhas(() => this._diff('--name-only', 'HEAD', '--'))) {
                nomes.add(f);
            }
        }
        return nomes;
    }

    // O que a mesclagem acrescentaria ao destino. Exit 1 é conflito, não erro: a árvore vem na
    // primeira linha do mesmo jeito, e conflito também é divergência a mostrar.
    _contribuicao(candidata, alvo) {
        let saida;
        try {
            saida = this.git('merge-tree', '--write-tree', candidata, alvo);
        } catch (e) {
            saida = e.stdout || '';
            this.conflitos = /^CONFLICT/m.test(saida);
        }
        const arvore = (saida.split('\n')[0] || '').trim();
        if (!/^[0-9a-f]{40}$/.test(arvore)) {
            return null;
        }
        return new Set(this._linhas(() =>
            this._diff('--name-only', `${candidata}^{tree}`, arvore, '--')));
    }

    _linhas(fn) {
        try {
            const t = fn().trim();
            return t ? t.split('\n') : [];
        } catch {
            return [];
        }
    }

    listarArquivos(base) {
        const nomes = this._diff('--name-status', base, ...this._alvo(), '--').trim();
        if (!nomes) {
            return [];
        }
        // `pendentes` null = a comparação de conteúdo falhou; aí vale a pegada inteira, não o vazio.
        const pendentes = this.pendentes;
        const numeros = new Map();
        for (const linha of this._diff('--numstat', base, ...this._alvo(), '--').trim().split('\n')) {
            const [mais, menos, ...resto] = linha.split('\t');
            if (resto.length) {
                numeros.set(resto[resto.length - 1], {
                    adicionadas: Number(mais) || 0,
                    removidas: Number(menos) || 0
                });
            }
        }
        return nomes.split('\n').map(l => {
            const partes = l.split('\t');
            const caminho = partes[partes.length - 1];
            return { estado: partes[0], caminho, ...(numeros.get(caminho) || { adicionadas: 0, removidas: 0 }) };
        }).filter(a => !pendentes || pendentes.has(a.caminho));
    }

    // Pede ao git só a margem de contexto e sintetiza a lacuna a partir do cabeçalho do hunk.
    // Antes pedia o arquivo inteiro (-U100000) e descartava 99%: num lockfile isso eram 442 KB de
    // texto e 19 mil objetos por requisição, contra 1,6 KB agora.
    montarColunas(base, caminho, opcoes = {}) {
        const margem = opcoes.margem ?? MARGEM_PADRAO;
        let bruto;
        try {
            bruto = this._diff(opcoes.completo ? CONTEXTO_TOTAL : `-U${margem}`, base, ...this._alvo(), '--', caminho);
        } catch {
            return { antes: [], depois: [], adicionadas: 0, removidas: 0, total: 0, dobradas: 0 };
        }
        const antes = [];
        const depois = [];
        let adicionadas = 0;
        let removidas = 0;
        let nA = 0;
        let nD = 0;
        let fimAnterior = null;
        let dobradas = 0;
        const pendentes = [];
        // O texto de cada linha removida e de cada adicionada, na ordem do arquivo: é por essa
        // ordem que o word-diff é conferido antes de virar realce dentro da linha.
        const remocoes = [];
        const adicoes = [];
        const pares = [];

        const descarregar = () => {
            for (const p of pendentes) {
                antes.push({ n: ++nA, texto: p.texto, tipo: 'rem' });
                depois.push({ n: null, texto: '', tipo: 'vazio' });
            }
            pendentes.length = 0;
        };
        const lacuna = quantas => {
            dobradas += quantas;
            const marca = { n: null, texto: `⋯ ${quantas} linha${quantas > 1 ? 's' : ''} sem alteração`, tipo: 'lacuna' };
            antes.push(marca);
            depois.push({ ...marca });
        };

        for (const linha of bruto.split('\n')) {
            const cab = linha.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
            if (cab) {
                descarregar();
                const iniA = Number(cab[1]);
                const iniD = Number(cab[3]);
                const salto = fimAnterior === null ? iniA - 1 : iniA - fimAnterior - 1;
                if (salto > 0) {
                    lacuna(salto);
                }
                nA = iniA - 1;
                nD = iniD - 1;
                fimAnterior = iniA + (cab[2] === undefined ? 1 : Number(cab[2])) - 1;
                continue;
            }
            if (linha.startsWith('diff ') || linha.startsWith('index ') || linha.startsWith('--- ')
                || linha.startsWith('+++ ') || linha.startsWith('\\') || linha.startsWith('new file')
                || linha.startsWith('deleted file') || linha.startsWith('similarity')
                || linha.startsWith('rename ') || linha.startsWith('old mode') || linha.startsWith('new mode')) {
                continue;
            }
            const marca = linha[0];
            const texto = linha.slice(1);
            if (marca === '-') {
                remocoes.push(texto);
                pendentes.push({ texto, indice: remocoes.length - 1 });
                removidas++;
            } else if (marca === '+') {
                adicoes.push(texto);
                adicionadas++;
                const parceira = pendentes.shift();
                if (parceira !== undefined) {
                    const daEsquerda = { n: ++nA, texto: parceira.texto, tipo: 'rem' };
                    const daDireita = { n: ++nD, texto, tipo: 'add' };
                    antes.push(daEsquerda);
                    depois.push(daDireita);
                    pares.push({
                        daEsquerda, daDireita,
                        indiceAntes: parceira.indice, indiceDepois: adicoes.length - 1
                    });
                } else {
                    antes.push({ n: null, texto: '', tipo: 'vazio' });
                    depois.push({ n: ++nD, texto, tipo: 'add' });
                }
            } else if (marca === ' ') {
                descarregar();
                antes.push({ n: ++nA, texto, tipo: 'ctx' });
                depois.push({ n: ++nD, texto, tipo: 'ctx' });
            }
        }
        descarregar();
        this._aplicarTrechos(base, caminho, { pares, remocoes, adicoes }, opcoes);
        // A sobra vem do lado DEPOIS (`nD`), que é o que o disco mede. Usar `nA` anexava uma lacuna
        // falsa do tamanho do arquivo em arquivo NOVO, onde o lado antes fica em zero.
        //
        // Arquivo APAGADO não tem lado depois: o hunk é `@@ -1,18 +0,0 @@`, então `nD` fica em -1 e o
        // fallback propagava um total negativo (o rótulo mostrava "ver arquivo inteiro (-1)"). Sem
        // arquivo no disco não há sobra a dobrar, e o total que faz sentido é a contagem do lado antes.
        const totalDoDisco = this._totalDeLinhas(caminho);
        const total = totalDoDisco || Math.max(nA, nD, 0);
        if (!opcoes.completo && totalDoDisco > 0) {
            const sobra = totalDoDisco - nD;
            if (sobra > 0) {
                lacuna(sobra);
            }
        }
        return { antes, depois, adicionadas, removidas, total, dobradas };
    }

    // Acrescenta `trechos` às linhas de um par rem/add: a lista de pedaços da linha com `mudou`
    // dizendo quais mudaram. Campo NOVO e opcional — ele não vem quando a reconstrução não confere,
    // porque realce no pedaço errado é pior que realce nenhum.
    _aplicarTrechos(base, caminho, { pares, remocoes, adicoes }, opcoes) {
        if (opcoes.trechos === false || !pares.length || pares.length > PARES_PARA_TRECHOS) {
            return;
        }
        let bruto;
        try {
            bruto = this._diff('-U0', '--word-diff=porcelain', PALAVRAS, base, ...this._alvo(), '--', caminho);
        } catch {
            return;
        }
        const lidos = this._lerPalavras(bruto, remocoes, adicoes);
        if (!lidos) {
            return;
        }
        for (const par of pares) {
            const daEsquerda = lidos.antes[par.indiceAntes];
            const daDireita = lidos.depois[par.indiceDepois];
            // Par sem nada em comum não informa além do que a cor da linha inteira já diz.
            if (daEsquerda && daDireita && (daEsquerda.length > 1 || daDireita.length > 1)) {
                par.daEsquerda.trechos = daEsquerda;
                par.daDireita.trechos = daDireita;
            }
        }
    }

    // O `~` do word-diff é o fim de uma linha da SAÍDA e não diz de qual lado veio: quando um lado
    // tem mais linhas que o outro, os dois deixam de andar juntos — o git emite até a indentação de
    // uma linha INSERIDA como pedaço comum, e ela cola na linha removida de cima. Daí a leitura só
    // aceitar hunk com o mesmo número de linhas dos dois lados, e só quando o texto reconstruído
    // bate com o que o diff de linha já trouxe.
    _lerPalavras(bruto, remocoes, adicoes) {
        const antes = [];
        const depois = [];
        let iA = 0;
        let iD = 0;
        let hunk = null;
        const encerrar = () => {
            if (!hunk) {
                return;
            }
            if (hunk.a > 0 && hunk.a === hunk.d) {
                const lidos = this._pedacosEmLinhas(hunk.pedacos,
                    remocoes.slice(iA, iA + hunk.a), adicoes.slice(iD, iD + hunk.d));
                for (let i = 0; lidos && i < hunk.a; i++) {
                    antes[iA + i] = lidos.antes[i];
                    depois[iD + i] = lidos.depois[i];
                }
            }
            // Os índices andam mesmo quando o hunk é recusado: eles são a posição no arquivo, e
            // errar isso realçaria o pedaço de uma linha em outra.
            iA += hunk.a;
            iD += hunk.d;
            hunk = null;
        };
        for (const linha of bruto.split('\n')) {
            const cab = linha.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
            if (cab) {
                encerrar();
                hunk = {
                    a: cab[1] === undefined ? 1 : Number(cab[1]),
                    d: cab[2] === undefined ? 1 : Number(cab[2]),
                    pedacos: []
                };
                continue;
            }
            // Antes do primeiro `@@` só vêm os cabeçalhos do arquivo. Dentro do hunk, pedaço que
            // começa com `\` é o "No newline at end of file".
            if (hunk && (linha === '~' || ' -+'.includes(linha[0]))) {
                hunk.pedacos.push(linha);
            }
        }
        encerrar();
        return { antes, depois };
    }

    _pedacosEmLinhas(pedacos, esperadoAntes, esperadoDepois) {
        const antes = [];
        const depois = [];
        let atualAntes = [];
        let atualDepois = [];
        for (const pedaco of pedacos) {
            if (pedaco === '~') {
                antes.push(atualAntes);
                depois.push(atualDepois);
                atualAntes = [];
                atualDepois = [];
                continue;
            }
            const texto = pedaco.slice(1);
            if (pedaco[0] !== '+') {
                this._emendar(atualAntes, texto, pedaco[0] === '-');
            }
            if (pedaco[0] !== '-') {
                this._emendar(atualDepois, texto, pedaco[0] === '+');
            }
        }
        if (antes.length !== esperadoAntes.length || depois.length !== esperadoDepois.length) {
            return null;
        }
        for (let i = 0; i < esperadoAntes.length; i++) {
            if (this._texto(antes[i]) !== esperadoAntes[i] || this._texto(depois[i]) !== esperadoDepois[i]) {
                return null;
            }
        }
        return { antes, depois };
    }

    // Palavra e espaço vêm em pedaços separados do git; sem emendar os vizinhos de mesmo estado, a
    // linha viraria uma lista de dezenas de pedaços de um caractere para o cliente pintar.
    _emendar(pedacos, texto, mudou) {
        const ultimo = pedacos[pedacos.length - 1];
        if (ultimo && ultimo.mudou === mudou) {
            ultimo.texto += texto;
            return;
        }
        pedacos.push({ texto, mudou });
    }

    _texto(pedacos) {
        return pedacos.map(p => p.texto).join('');
    }

    // Sem `ref` o arquivo está no disco e não custa processo nenhum. Com `ref`, o conteúdo vem do
    // cat-file de vida longa: abrir 15 arquivos eram 15 processos e 197 ms, contra 1 processo, 31 ms
    // na primeira vez (o spawn) e 19 ms depois — e o processo é por REPO, então vale entre pedidos.
    _totalDeLinhas(caminho) {
        try {
            if (!this.ref) {
                return this._contarLinhas(readFileSync(join(this.projeto, caminho)));
            }
            const cat = CatFile.de(this.projeto);
            const blob = cat.blob(this.ref, caminho);
            if (blob) {
                return this._contarLinhas(blob);
            }
            if (!cat.desistiu) {
                return 0;
            }
            return this._contarLinhas(Buffer.from(this.git('show', `${this.ref}:${caminho}`)));
        } catch {
            return 0;
        }
    }

    // Binário não tem linha a contar e o rótulo "ver arquivo inteiro (N)" mentiria: o `git show`
    // com encoding utf8 contava o lixo entre os bytes 0x0A como linha de código.
    _contarLinhas(buf) {
        if (buf.indexOf(0) >= 0) {
            return 0;
        }
        let quantas = 0;
        for (let i = 0; i < buf.length; i++) {
            if (buf[i] === 10) {
                quantas++;
            }
        }
        // Todo arquivo termina em newline: contar esse fim como linha inflava o rótulo em 1 e
        // criava uma lacuna falsa de 1 linha em arquivo novo.
        return buf.length && buf[buf.length - 1] !== 10 ? quantas + 1 : quantas;
    }

    completo(base) {
        const baseReal = this.resolverBase(base);
        const arquivos = this.listarArquivos(baseReal).map(a => ({
            ...a,
            ...this.montarColunas(baseReal, a.caminho)
        }));
        return { projeto: this.projeto, branch: this.branch(), base: baseReal, arquivos };
    }
}

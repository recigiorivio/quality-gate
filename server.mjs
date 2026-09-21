// Tela local para ver o diff das tarefas. Sem dependência: node:http puro.
// O diff é montado a cada requisição, então não existe arquivo temporário para envelhecer.
//
// uso: npm start   (ou node server.mjs)   →   http://localhost:4100

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync, existsSync, statSync, appendFileSync, readdirSync, mkdirSync } from 'node:fs';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname, relative, basename } from 'node:path';
import { Diff, WORKSPACE } from './lib/diff.mjs';
import { Workspace } from './lib/workspace.mjs';
import { Qualidade } from './lib/qualidade.mjs';
import { Pontos } from './ferramentas/pontos.mjs';
import lint from './lib/lint.mjs';
import { corridas, caminhoEstado, meta } from './lib/db.mjs';
import comparacao from './lib/comparacao.mjs';
import implantacao from './lib/implantacao.mjs';
import sessoes from './lib/sessoes.mjs';
import prs from './lib/prs.mjs';
import linear from './lib/linear.mjs';
import { pagina } from './web/pagina.mjs';
import { aplicarEnv, CAMINHO_ENV } from './lib/env.mjs';
import { CONFIGS, comCaminhos } from './lib/configs.mjs';
import { caminhoPadrao, refDoClone } from './lib/gatilhos.mjs';

// O prompt do agente mandava `qualidade/ferramentas/…` com o workspace escrito à mão: os dois só
// valiam nesta máquina, e o clone do próprio README cria a pasta com OUTRO nome (`quality-gate`).

// qualidade:ok declaracao-solta-em-arquivo-de-classe
const AQUI = relative(WORKSPACE, dirname(fileURLToPath(import.meta.url))) || '.';
// qualidade:ok declaracao-solta-em-arquivo-de-classe
const RAIZ = dirname(fileURLToPath(import.meta.url));

// Antes de qualquer `process.env`: o `.env` do projeto passa a valer para PORT, QUALIDADE_HOST e
// QUALIDADE_TOKEN também. O shell continua ganhando do arquivo.
aplicarEnv();

// O prompt do agente, fixo. É a tarefa que a máquina não faz: num repo com 7 PRs do mesmo chamado,
// seis mescladas e a aberta sendo outra, nenhuma regra local diz qual importa.
const PROMPT_COMPARACAO = (chamado, inventario) => `Decida a comparação de diff correta de cada repo do chamado ${chamado} e grave. Nada além disso.

O inventário JÁ ESTÁ LEVANTADO abaixo — não refaça gh pr list nem contexto.mjs. Para cada repo há as PRs cujo título tem o ID (número, estado, branch, base, atualização) e as branches locais que contêm o ID.

${inventario}

Regra de decisão, por repo:
- PR aberta ganha de PR mesclada (é onde está o trabalho de agora)
- todas mescladas: a de updatedAt mais recente, e --nota dizendo que as outras já entraram
- nenhuma PR: --stage
- PR mesclada mas com commit local depois dela (confira com git log origin/<base>..<branch> só se houver dúvida): --pr=N --aberto

Grave a partir de ${WORKSPACE}, um comando por repo:
  node --disable-warning=ExperimentalWarning ${AQUI}/ferramentas/comparacao.mjs definir ${chamado} <repo> --pr=<N> --nota="<por que, em uma frase>"
  ou  node --disable-warning=ExperimentalWarning ${AQUI}/ferramentas/comparacao.mjs definir ${chamado} <repo> --stage
A flag evita o ExperimentalWarning do SQLite no stderr; não troque por --no-warnings.

NÃO confira número de arquivos: o servidor confere ao final e mostra o que não bateu.
Só o chamado ${chamado}: não olhe, não decida e não grave nada de nenhum outro. Não rode teste de projeto. Não edite arquivo nenhum, não commite, não abra PR. NÃO mate nem reinicie o servidor da porta 4100.
Responda em no máximo 3 linhas: quantos repos, quantos decididos, e alguma dúvida que ficou.`;

// O modelo vem do default do CLI (~/.claude/settings.json): quem troca é o `/model`, e a corrida
// herda. Ler aqui é o que impede a troca de ser invisível na tela.
const MODELO_DA_SESSAO = () => {
    try {
        return JSON.parse(readFileSync(join(process.env.HOME, '.claude/settings.json'), 'utf8')).model || 'default do CLI';
    } catch {
        return 'default do CLI';
    }
};

// O prompt da implantação. Fixo aqui pelo mesmo motivo do outro: o cliente só escolhe os repos, e
// página local montando prompt é injeção. O inventário vem pronto — o agente não precisa varrer.
const PROMPT_IMPLANTACAO = (repos, inventario) => `Analise a implantação de stage para main destes repos: ${repos}.

O inventário já está levantado. NÃO refaça git log nem gh; leia o código quando precisar entender uma mudança.

${inventario}

Diga, em português, o que eu preciso saber ANTES de mesclar — e só o que muda a decisão:

1. O que entra, por repo, em uma linha cada: o efeito para quem usa, não o nome do arquivo.
2. Ordem de implantação, se importa: migrate antes do serviço, biblioteca antes de quem a consome,
   contrato de fila/rota que quebra se um lado for sem o outro. Diga o porquê de cada dependência.
3. Riscos: mudança de contrato (rota, fila, schema, enum), índice novo em coleção grande, migrate
   destrutivo, mudança de comportamento padrão, remoção de campo que alguém pode estar lendo.
4. O que conferir DEPOIS do deploy, e onde olhar (log, métrica, tela).
5. O que ficou pela metade: chamado cujo trabalho aparece em um repo e não nos outros da lista.

Se algo não der para afirmar pelo diff, diga que não dá — não invente. Não edite arquivo nenhum,
não commite, não abra PR, não rode teste de projeto, e não mate o servidor da porta 4100.`;

const PORTA = Number(process.env.PORT || 4100);
// Preso em 127.0.0.1 por padrão. Expor é opt-in E exige senha, porque `/api/agente` spawna um
// `claude -p` com Bash nesta máquina: sem token, qualquer um na rede executaria comando aqui.
const HOST = process.env.QUALIDADE_HOST || '127.0.0.1';
let TOKEN = process.env.QUALIDADE_TOKEN || '';
let sorteado = false;
const SO_LOCAL = HOST === '127.0.0.1' || HOST === 'localhost';
// `::ffff:127.0.0.1` é o mesmo 127.0.0.1 em socket IPv6: comparar só a string crua deixaria a
// própria máquina de fora quando o Node aceita a conexão pela pilha dupla.
const ehLocal = ip => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(ip || ''));
const execFileAsync = promisify(execFile);

// Igual ao teto da aba Configurações: as duas rotas agora carregam markdown escolhido por gente.
const LIMITE_CORPO = 512 * 1024;

class Servidor {
    constructor() {
        this.workspace = new Workspace();
        this.qualidade = new Qualidade();
        this.pontos = new Pontos();
        this.cache = new Map();
        this.ouvintes = new Set();
        this.ocultos = new Set(this.lerOcultos());
        this.mostradosEm = {};
    }

    // Preferência de gente, e por isso mora no diretório de estado, junto do banco: preso na raiz,
    // ficava fora do `QUALIDADE_ESTADO` e toda sonda gravava a escolha de verdade do usuário.
    arquivoOcultos() {
        return join(caminhoEstado(), 'ocultos.json');
    }

    lerOcultos() {
        try {
            const arquivo = this.arquivoOcultos();
            return existsSync(arquivo) ? JSON.parse(readFileSync(arquivo, 'utf8')) : [];
        } catch {
            return [];
        }
    }

    gravarOcultos() {
        writeFileSync(this.arquivoOcultos(), JSON.stringify([...this.ocultos], null, 2));
        this.cache.delete('chamados');
    }

    json(res, dados, codigo = 200) {
        const corpo = JSON.stringify(dados);
        res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(corpo) });
        res.end(corpo);
    }

    // Roda a ferramenta de linha de comando e devolve a saída crua: uma implementação só,
    // usada pela tela e pelo terminal.
    ferramenta(nome, args) {
        try {
            return { codigo: 0, saida: execFileSync('node', [join(import.meta.dirname, 'ferramentas', nome), ...args], {
                encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe']
            }) };
        } catch (e) {
            return { codigo: e.status ?? 1, saida: `${e.stdout || ''}${e.stderr || ''}` };
        }
    }

    // Cache com invalidação explícita: o TTL é a rede de segurança, o gatilho de verdade é o commit.
    // Serve o velho e revalida atrás: expirado deixa de ser motivo para ESPERAR. A tela abre com o
    // que já tem, o recálculo roda fora do caminho da requisição, e um evento SSE avisa — só se o
    // valor mudou de verdade, senão o redesenho seria piscada sem informação.
    emCache(chave, calcular, ttl = 300000) {
        const guardado = this.cache.get(chave);
        if (guardado) {
            const idade = Date.now() - guardado.quando;
            if (idade >= ttl) {
                this.revalidar(chave, calcular, false);
            }
            return {
                ...guardado.valor, doCache: true, desde: guardado.quando,
                revalidando: idade >= ttl
            };
        }
        const valor = calcular();
        this.cache.set(chave, { quando: Date.now(), valor, impressao: this._impressao(valor) });
        return { ...valor, doCache: false, desde: Date.now() };
    }

    // `setTimeout(0)` porque o cálculo sync (git do diff) travaria o event loop no meio da resposta
    // que está sendo escrita. Uma revalidação por chave de cada vez: sem a trava, cada requisição
    // de uma chave velha enfileirava outra varredura.
    revalidar(chave, calcular, assincrono) {
        const guardado = this.cache.get(chave);
        if (!guardado || guardado.revalidando) {
            return;
        }
        guardado.revalidando = true;
        const gravar = valor => {
            const impressao = this._impressao(valor);
            const mudou = impressao !== guardado.impressao;
            this.cache.set(chave, { quando: Date.now(), valor, impressao });
            if (mudou) {
                this.avisar({ tipo: 'atualizado', chave });
            }
        };
        const erro = () => {
            // Falhou a revalidação: mantém o velho e libera a trava, para a próxima tentar de novo.
            guardado.revalidando = false;
        };
        if (assincrono) {
            Promise.resolve().then(calcular).then(gravar).catch(erro);
            return;
        }
        setTimeout(() => {
            try {
                gravar(calcular());
            } catch {
                erro();
            }
        }, 0);
    }

    // Impressão barata só para responder "mudou?": a alternativa era comparar objetos inteiros a
    // cada revalidação, e o que se decide com isso é apenas redesenhar ou não.
    _impressao(valor) {
        try {
            const t = JSON.stringify(valor);
            let h = 0;
            for (let i = 0; i < t.length; i++) {
                h = (h * 31 + t.charCodeAt(i)) | 0;
            }
            return `${t.length}:${h}`;
        } catch {
            return String(Date.now());
        }
    }

    // Versão assíncrona do cache, para o que é rede. Guarda a PROMESSA: duas requisições
    // simultâneas do mesmo dado esperam a mesma chamada em vez de disparar duas.
    async emCacheAsync(chave, calcular, ttl = 300000) {
        const guardado = this.cache.get(chave);
        if (guardado) {
            const idade = Date.now() - guardado.quando;
            if (idade >= ttl) {
                this.revalidar(chave, calcular, true);
            }
            const valor = await guardado.valor;
            return { ...valor, doCache: true, desde: guardado.quando, revalidando: idade >= ttl };
        }
        const promessa = calcular();
        this.cache.set(chave, { quando: Date.now(), valor: promessa });
        try {
            const valor = await promessa;
            // A impressão só existe depois que a promessa resolve: guardar antes compararia contra
            // a promessa, e toda revalidação pareceria mudança.
            const atual = this.cache.get(chave);
            if (atual && atual.valor === promessa) {
                atual.impressao = this._impressao(valor);
            }
            return { ...valor, doCache: false, desde: Date.now() };
        } catch (e) {
            this.cache.delete(chave);
            throw e;
        }
    }

    // Nomear o que mudou, como em `/api/implantacao-escolher`: `repo` grava UMA linha e `remover`
    // apaga UMA. A lista inteira é a cópia velha da aba, e por isso exige `substituir: true`.
    salvarRepos(req, res) {
        let corpo = '';
        req.on('data', d => {
            corpo += d;
            if (corpo.length > 512 * 1024) {
                req.destroy();
            }
        });
        req.on('end', () => {
            try {
                const { repo, remover, repos: entradas, substituir } = JSON.parse(corpo || '{}');
                if (repo) {
                    const linha = implantacao.catalogo.salvarUm(repo);
                    return this.responderRepos(res, 'salvar-um', linha.projeto);
                }
                if (remover) {
                    const foi = implantacao.catalogo.remover(remover);
                    return this.responderRepos(res, 'remover', `${remover}${foi ? '' : ' (não estava no catálogo)'}`);
                }
                if (Array.isArray(entradas) && substituir === true) {
                    implantacao.catalogo.substituirTudo(entradas);
                    return this.responderRepos(res, 'substituir-tudo', `${entradas.length} enviados`);
                }
                // Aceitar a lista sem `substituir` "por compatibilidade" seria manter o defeito
                // com outro nome: é exatamente o pedido que apagava a edição da outra aba.
                this.registrar('repos', 'recusado',
                    `pedido sem repo/remover/substituir${Array.isArray(entradas) ? ` (lista de ${entradas.length})` : ''}`);
                return this.json(res, {
                    erro: 'diga o que mudou: {"repo":{…}} grava uma linha, {"remover":"projeto"} apaga uma.'
                        + ' A lista inteira só com {"repos":[…],"substituir":true} — ela apaga todo repo que não vier nela.'
                }, 400);
            } catch (e) {
                // Pedido malformado do cliente é 400, não 500: `salvarUm` recusa `{repo:{}}` sem
                // projeto, e devolver 500 ali culpa o servidor por erro de quem chamou — e some no
                // meio dos alertas de falha de verdade.
                const doCliente = /sem projeto|forma esperada|JSON|deve ser|inválid/i.test(e.message);
                return this.json(res, { erro: e.message }, doCliente ? 400 : 500);
            }
        });
    }

    responderRepos(res, acao, detalhe) {
        const repos = implantacao.catalogo.listar();
        this.registrar('repos', acao, `${detalhe}; ${repos.filter(r => r.ativo).length} ativos de ${repos.length}`);
        this.invalidarImplantacao();
        return this.json(res, { ok: true, repos, detectadoEm: implantacao.catalogo.detectadoEm() });
    }

    // Toda leitura da implantação sai do par de branches do catálogo: mexeu no catálogo, o que
    // estava em cache respondeu por uma comparação que não é mais a que vale.
    invalidarImplantacao() {
        for (const chave of [...this.cache.keys()]) {
            if (chave === 'implantacao' || chave.startsWith('impl|')) {
                this.cache.delete(chave);
            }
        }
    }

    // Primeira abertura. A marca fica no ESTADO, não no disco do projeto: um clone novo apontando
    // para o mesmo `QUALIDADE_ESTADO` já está instalado, e perguntar de novo seria só atrito.
    primeiraVez(raiz = null) {
        const alvo = raiz || WORKSPACE;
        return {
            primeira: !meta('instalacao.concluidaEm'),
            workspace: alvo,
            detectado: WORKSPACE,
            // `null` é pasta ilegível, `0` é pasta sem repo: quem digita caminho errado precisa ver
            // a diferença, senão "0 repos" parece opinião sobre o workspace e não erro de caminho.
            repos: this.contarRepos(alvo),
            configs: Object.entries(CONFIGS).map(([chave, c]) => ({
                chave, rotulo: c.rotulo, resumo: c.resumo, caminho: c.caminho,
                existe: existsSync(join(alvo, c.caminho)),
                padrao: existsSync(caminhoPadrao(c.caminho))
            }))
        };
    }

    contarRepos(raiz) {
        try {
            return readdirSync(raiz, { withFileTypes: true })
                .filter(d => d.isDirectory() && existsSync(join(raiz, d.name, '.git'))).length;
        } catch {
            return null;
        }
    }

    salvarPrimeiraVez(req, res) {
        let corpo = '';
        let estourou = false;
        req.on('data', d => {
            if (estourou) {
                return;
            }
            corpo += d;
            // Responder, não derrubar o socket: `req.destroy()` chega na tela como falha de rede, e
            // "o pedido sumiu" é exatamente o modo de falha silencioso que este projeto persegue.
            if (corpo.length > LIMITE_CORPO) {
                estourou = true;
                this.json(res, { erro: `passou de ${LIMITE_CORPO / 1024} KB — escolha um .md menor` }, 413);
            }
        });
        req.on('end', () => {
            if (estourou) {
                return;
            }
            try {
                const { raiz, instalar = [], escolhidos = {} } = JSON.parse(corpo || '{}');
                const alvo = raiz || WORKSPACE;
                if (this.contarRepos(alvo) === null) {
                    return this.json(res, { erro: `não consigo ler ${alvo}` }, 400);
                }
                const plantados = this.plantarPadroes(alvo, instalar, escolhidos);
                // Trocar a raiz exige reinício: `WORKSPACE` é resolvido na carga dos módulos, e
                // fingir que mudou agora deixaria metade da tela lendo a pasta antiga.
                const mudou = alvo !== WORKSPACE;
                if (mudou) {
                    this.gravarEnv('QUALIDADE_WORKSPACE', alvo);
                }
                meta('instalacao.concluidaEm', new Date().toISOString());
                this.registrar('instalacao', 'concluida', `${alvo} · ${plantados.escritos.length} padrão(ões)`);
                return this.json(res, { ok: true, ...plantados, precisaReiniciar: mudou, workspace: alvo });
            } catch (e) {
                return this.json(res, { erro: e.message }, 500);
            }
        });
    }

    // Nunca sobrescreve: arquivo que já existe é rotina do time, e plantar por cima na instalação
    // seria apagar o processo de quem já tinha um.
    //
    // `escolhidos` é o .md que a pessoa apontou no lugar do padrão. Vem como conteúdo, nunca como
    // caminho: o destino continua saindo do `CONFIGS`, senão o allowlist deixava de valer.
    plantarPadroes(raiz, chaves, escolhidos = {}) {
        const escritos = [];
        const pulados = [];
        const proprios = [];
        for (const chave of chaves) {
            const c = CONFIGS[chave];
            if (!c) {
                continue;
            }
            const escolhido = this.conteudoEscolhido(escolhidos[chave]);
            const origem = caminhoPadrao(c.caminho);
            if (!escolhido && !existsSync(origem)) {
                continue;
            }
            const destino = join(raiz, c.caminho);
            if (existsSync(destino)) {
                pulados.push(c.caminho);
                continue;
            }
            mkdirSync(dirname(destino), { recursive: true });
            // Os `{{CLONE}}`/`{{TELA}}` do padrão saem aqui com o caminho real. Vale também para o
            // `.md` que a pessoa aponta: se ela usar os tokens, funcionam igual.
            writeFileSync(destino, comCaminhos(escolhido ?? readFileSync(origem, 'utf8'),
                { clone: refDoClone(raiz, RAIZ), porta: PORTA }));
            escritos.push(c.caminho);
            if (escolhido) {
                proprios.push(c.caminho);
            }
        }
        return { escritos, pulados, proprios };
    }

    // Arquivo vazio é quase sempre picker errado, e plantar o vazio calado deixaria a rotina sem
    // conteúdo parecendo instalada.
    conteudoEscolhido(escolha) {
        const conteudo = escolha?.conteudo;
        if (typeof conteudo !== 'string' || !conteudo.trim()) {
            return null;
        }
        return conteudo;
    }

    // Reescreve a chave no `.env` do projeto em vez de acrescentar: duas linhas iguais fazem a
    // última ganhar em silêncio, e a primeira fica no arquivo parecendo estar valendo.
    gravarEnv(chave, valor) {
        const arquivo = CAMINHO_ENV;
        const linhas = existsSync(arquivo)
            ? readFileSync(arquivo, 'utf8').split('\n').filter(l => !l.trimStart().startsWith(`${chave}=`))
            : [];
        linhas.push(`${chave}=${valor}`);
        writeFileSync(arquivo, `${linhas.filter((l, i, a) => l.trim() || i < a.length - 1).join('\n').replace(/\n+$/, '')}\n`);
    }

    // Grava só o conteúdo, no caminho que a allowlist define. Backup ao lado antes de sobrescrever:
    // é arquivo de instrução editado à mão, e um salvamento errado apaga regra que custou caro.
    salvarConfig(req, res) {
        let corpo = '';
        req.on('data', d => {
            corpo += d;
            if (corpo.length > 512 * 1024) {
                req.destroy();
            }
        });
        req.on('end', () => {
            try {
                const { chave, conteudo } = JSON.parse(corpo || '{}');
                const c = CONFIGS[chave];
                if (!c) {
                    return this.json(res, { erro: 'chave desconhecida' }, 400);
                }
                if (typeof conteudo !== 'string' || !conteudo.trim()) {
                    return this.json(res, { erro: 'conteúdo vazio recusado' }, 400);
                }
                const alvo = join(WORKSPACE, c.caminho);
                // `.bak` só do que existe: salvar uma rotina ainda não plantada morria no backup, e
                // a aba Configurações é justamente por onde se planta a primeira versão dela.
                if (existsSync(alvo)) {
                    writeFileSync(`${alvo}.bak`, readFileSync(alvo));
                }
                mkdirSync(dirname(alvo), { recursive: true });
                writeFileSync(alvo, conteudo);
                this.avisar({ tipo: 'config-salva', chave });
                return this.json(res, { ok: true, chave, bytes: Buffer.byteLength(conteudo), quando: Date.now() });
            } catch (e) {
                return this.json(res, { erro: e.message }, 500);
            }
        });
    }

    registrar(acao, resultado, detalhe = '') {
        try {
            appendFileSync(join(caminhoEstado(), 'gate.log'),
                `${new Date().toISOString()}\t${acao}\t${resultado}\t${String(detalhe).slice(0, 200)}\n`);
        } catch {
            // log é observabilidade, não pode derrubar a rota
        }
    }

    // Fora do cache da varredura: decisões e arquivamento são lookup em dicionário, e dentro do
    // cache de 30 s uma decisão nova só aparecia meio minuto depois.
    responderChamados(res, dados) {
        // Os ocultos saem aqui, e nao na varredura: o Workspace responde o que existe, e o
        // que se escolhe ver e decisao da tela. Trocar isso esconderia repo esquecido do
        // proprio calculo que existe para achar repo esquecido.
        // FORA do cache: a varredura dos repos é caríssima e vale 30 s, mas a decisão é um lookup
        // em dicionário. Dentro do cache, uma decisão nova só aparecia 30 s depois — e a faixa
        // de mesclagem ficava dizendo "não decidido" com o diff ao lado já mostrando a PR.
        this.enriquecerDecisoes(dados.lista);
        this.arquivarResolvidos(dados.lista);
        return this.json(res, {
            ...dados,
            // Fora do `emCache`: o estado da corrida muda por segundo e não pode ficar em cache
            // de 30 s — a pessoa recarrega justamente para saber se o agente ainda está de pé.
            agente: {
                rodando: this.agenteRodando || null,
                passos: this.agenteRodando ? (this.agentePassos || 0) : 0,
                desde: this.agenteRodando ? this.agenteDesde : null,
                ultimo: this.agenteFim || null
            },
            lista: dados.lista.filter(c => !this.ocultos.has(c.chamado)),
            // Com o título: só o `UND-1638` na lista de ocultos não diz o que se está trazendo
            // de volta, exatamente como não dizia nas linhas visíveis.
            ocultos: dados.lista.filter(c => this.ocultos.has(c.chamado))
                .map(c => ({ chamado: c.chamado, titulo: c.titulo || null }))
        });
    }

    // Invalida por projeto, por chamado, ou tudo. Por chamado é o recorte que faltava: um chamado
    // toca vários repos, e derrubar só o que está aberto deixava os outros seis com dado velho.
    // Lê do cache; só varre o disco se a lista ainda não foi pedida uma vez.
    _reposDoChamado(chamado) {
        // A última lista conhecida, não o cache: ele guarda promessa, e isto é chamado de caminho
        // sync. Sem lista ainda (nenhuma abertura de tela), o escopo por chamado não se aplica.
        const lista = this.ultimaLista;
        return lista ? (lista.find(x => x.chamado === chamado)?.repos || []).map(r => r.projeto) : [];
    }

    invalidar({ projeto, chamado, silencioso } = {}) {
        const alvos = new Set();
        if (projeto) {
            alvos.add(projeto);
        }
        if (chamado) {
            alvos.add(chamado);
            // Os repos do chamado: as chaves de cache são por projeto, não por chamado. Vem da lista
            // JÁ em cache — refazer a varredura dos repos aqui custava 6,1 s de event loop bloqueado,
            // e a barra que disparou a invalidação acabou de ler essa mesma lista.
            for (const r of this._reposDoChamado(chamado)) {
                alvos.add(r);
            }
        }
        let n = 0;
        for (const chave of [...this.cache.keys()]) {
            const casa = !alvos.size || [...alvos].some(a => chave.includes(a));
            if (casa || (chamado && chave === 'chamados')) {
                this.cache.delete(chave);
                n++;
            }
        }
        // `silencioso` é para quem pediu e vai recarregar sozinho: o eco do próprio pedido disputava
        // com o reload explícito, e o do evento populava o cache que o explícito então lia.
        // O hook (PostToolUse) não passa silencioso, então outras abas continuam sendo avisadas.
        if (!silencioso) {
            this.avisar({ tipo: 'invalidado', projeto: projeto || null, chamado: chamado || null, chaves: n });
        }
        return { invalidadas: n, escopo: chamado ? `chamado ${chamado}` : (projeto || 'tudo'), alvos: [...alvos] };
    }

    // SSE: a tela aberta descobre sozinha que o diff mudou, sem ficar perguntando de 5 em 5 segundos.
    avisar(dados) {
        const corpo = `data: ${JSON.stringify(dados)}\n\n`;
        for (const res of this.ouvintes) {
            try {
                res.write(corpo);
            } catch {
                this.ouvintes.delete(res);
            }
        }
    }

    eventos(req, res) {
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive'
        });
        // A versão vai no "ligado", e o SSE reconecta sozinho depois de um reinício: é assim que a
        // aba aberta descobre que o app.js dela é velho. Sem isso ela segue rodando o JS antigo em
        // memória — `no-store` não ajuda, porque o problema não é cache, é a página não recarregar.
        res.write(`data: ${JSON.stringify({ tipo: 'ligado', versao: this.versaoDosAssets() })}\n\n`);
        this.ouvintes.add(res);
        const ping = setInterval(() => {
            try {
                res.write(': ping\n\n');
            } catch {
                clearInterval(ping);
            }
        }, 25000);
        req.on('close', () => {
            clearInterval(ping);
            this.ouvintes.delete(res);
        });
    }

    // Rede e processo externo sempre assíncronos: um execFileSync aqui trava todas as outras rotas.
    async ferramentaAsync(nome, args) {
        try {
            const { stdout } = await execFileAsync('node', [join(import.meta.dirname, 'ferramentas', nome), ...args], {
                cwd: WORKSPACE, encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024
            });
            return { codigo: 0, saida: stdout };
        } catch (e) {
            return { codigo: e.code ?? 1, saida: `${e.stdout || ''}${e.stderr || ''}` };
        }
    }

    // O lint é o passo lento em repo grande — só sob demanda.
    // O linter do projeto, sobre os arquivos do diff. Antes era `npm run check` no repo inteiro:
    // segundos de espera e 83 problemas de código que ninguém tocou.
    async lint(projeto, ref = '', chamado = null) {
        const { diff: d, base } = comparacao.resolver(projeto, ref, null, chamado);
        const arquivos = d.listarArquivos(base).map(a => a.caminho);
        const r = await lint.rodar(projeto, arquivos);
        const erros = r.achados.filter(a => a.severidade === 'erro');
        return {
            projeto,
            linters: r.linters,
            falhas: r.falhas ?? [],
            nota: r.nota ?? null,
            total: r.total ?? 0,
            erros: erros.length,
            achados: r.achados
        };
    }

    // Roda o agente de verdade (`claude -p`) para a única coisa que não dá para automatizar: decidir
    // qual PR/branch é a comparação certa de cada repo. O prompt é FIXO aqui — o cliente só manda o
    // ID, validado contra o padrão de chamado. Página local montando prompt seria injeção.
    // `git fetch` mexe em ref de remoto — não toca branch local nem árvore de trabalho — mas ainda
    // é escrita no `.git`, e por isso vale a mesma regra da corrida e da PR: só da máquina do
    // servidor. Pela LAN a tela é para VER.
    //
    // Serializado: dois cliques concorrentes seriam 204 `git fetch` disputando a mesma rede e o
    // mesmo `.git`, e o segundo não traria nada que o primeiro já não fosse trazer.
    async atualizarImplantacao(res, remoto) {
        if (!ehLocal(remoto)) {
            this.registrar('implantacao', 'negado-lan', `${remoto} pediu atualizar`);
            return this.json(res, { ok: false, erro: 'atualizar os repos só da máquina do servidor' });
        }
        if (this.buscandoRemoto) {
            return this.json(res, { ok: false, erro: 'já estou buscando' });
        }
        this.buscandoRemoto = true;
        const inicio = Date.now();
        try {
            const r = await implantacao.buscarRemoto();
            // Com os refs novos, tudo que estava em cache virou resposta de um git que não existe mais.
            this.invalidarImplantacao();
            const falhos = r.achados.filter(a => !a.ok);
            this.registrar('implantacao', 'atualizar',
                `${r.repos} repos em ${Date.now() - inicio}ms, ${falhos.length} sem nenhum ref`);
            return this.json(res, {
                ok: true, buscadoEm: r.buscadoEm, repos: r.repos,
                segundos: Math.round((Date.now() - inicio) / 100) / 10,
                semRefs: falhos.map(a => a.projeto),
                fila: await implantacao.resumo(),
                escolhidos: implantacao.escolhidos()
            });
        } catch (e) {
            return this.json(res, { ok: false, erro: e.message });
        } finally {
            this.buscandoRemoto = false;
        }
    }

    async abrirPrDeRelease(projeto, res) {
        const d = await implantacao.detalhe(projeto);
        if (!d) {
            return this.json(res, { ok: false, erro: 'sem origin/main ou origin/stage neste repo' });
        }
        const jaTem = await implantacao.prAberta(projeto);
        if (jaTem) {
            return this.json(res, { ok: false, erro: `já existe a PR #${jaTem.number}`, url: jaTem.url });
        }
        const titulo = `Release ${new Date().toISOString().slice(0, 10)} — ${d.ids.join(', ') || `${d.commits} commits`}`;
        const corpo = [
            `${d.commits} commits · ${d.arquivos} arquivos · +${d.adicionadas} -${d.removidas}`,
            '',
            d.ids.length ? `## Chamados\n${d.ids.map(i => `- ${i}`).join('\n')}` : '',
            d.migrates.length ? `## Migrates — rodar antes do serviço\n${d.migrates.map(m => `- \`${m}\``).join('\n')}` : '',
            d.pacote ? '> Mexe em `package.json`.' : '',
            '## Commits',
            d.listaDeCommits.map(c => `- \`${c.hash}\` ${c.titulo}`).join('\n'),
            '',
            '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
            '',
            'https://claude.ai/code/session_01DT4ir9PryhV3UDBxCrzdJG'
        ].filter(Boolean).join('\n');
        const r = await implantacao.abrirPr(projeto, { titulo, corpo });
        this.registrar('implantacao', r.ok ? 'pr-aberta' : 'pr-falhou', `${projeto} ${r.url || r.erro}`);
        return this.json(res, { ...r, projeto, titulo });
    }

    // A mesma corrida do agente, outro prompt e outro inventário. Só de localhost, pelo mesmo
    // motivo: spawna `claude -p` com Bash nesta máquina.
    async agenteImplantacao(projetos, res, remoto) {
        if (!ehLocal(remoto)) {
            return this.json(res, { ok: false, erro: 'a corrida do agente só roda na máquina do servidor' });
        }
        if (!projetos.length) {
            return this.json(res, { ok: false, erro: 'nenhum repo escolhido' });
        }
        if (this.agenteRodando) {
            return this.json(res, { ok: false, erro: `já rodando para ${this.agenteRodando}` });
        }
        this.agenteRodando = 'implantação';
        this.agentePassos = 0;
        this.agenteDesde = Date.now();
        this.registrar('agente', 'inicio', `implantação: ${projetos.join(',')}`);
        this.json(res, { ok: true, chamado: 'implantação', aviso: 'acompanhe pelo SSE' });
        this.avisar({ tipo: 'agente', fase: 'andando', chamado: 'implantação', passo: 0,
            texto: `modelo ${MODELO_DA_SESSAO()} · esforço high — levantando o que entra em ${projetos.length} repo(s)…` });
        const partes = await Promise.all(projetos.map(async p => {
            const d = await implantacao.detalhe(p);
            if (!d) {
                return `### ${p}\n  (sem origin/main ou origin/stage)`;
            }
            return `### ${p}  —  ${d.commits} commits, ${d.arquivos} arquivos, +${d.adicionadas} -${d.removidas}`
                + `\n  chamados: ${d.ids.join(', ') || '(nenhum ID nos títulos)'}`
                + (d.migrates.length ? `\n  MIGRATES: ${d.migrates.join(', ')}` : '')
                + (d.pacote ? '\n  mexe em package.json' : '')
                + `\n  base para o diff: git -C ${p} diff ${d.base} ${d.origem}`
                + `\n  commits:\n${d.listaDeCommits.map(c => `    ${c.hash} ${c.titulo} (${c.autor}, ${c.data.slice(0, 10)})`).join('\n')}`;
        }));
        this._rodarAgente('implantação', partes.join('\n\n'), Date.now(), PROMPT_IMPLANTACAO(projetos.join(', '), partes.join('\n\n')));
    }

    // Só de localhost. O token protege o acesso; isto protege a CAPACIDADE: pela LAN a tela é para
    // ver, e a corrida — que spawna `claude -p` com Bash aqui — não deve nem estar disponível.
    // Token vazado, máquina emprestada, aba esquecida: nenhum desses vira execução de comando.
    agente(chamado, res, remoto) {
        if (!ehLocal(remoto)) {
            this.registrar('agente', 'negado-lan', `${remoto} pediu ${chamado}`);
            return this.json(res, {ok: false, erro: 'a corrida do agente só roda na máquina do servidor'});
        }
        if (!/^[A-Z]{2,5}-\d+$/.test(chamado || '')) {
            return this.json(res, { ok: false, erro: 'ID de chamado inválido' });
        }
        if (this.agenteRodando) {
            return this.json(res, { ok: false, erro: `já rodando para ${this.agenteRodando}` });
        }
        this.agenteRodando = chamado;
        this.agentePassos = 0;
        this.agenteDesde = Date.now();
        this.registrar('agente', 'inicio', chamado);
        const inicio = Date.now();
        this.json(res, { ok: true, chamado, aviso: 'acompanhe pelo SSE' });
        // Inventário pronto no prompt: a primeira corrida gastou ~50 passos e 7 min, e mais da metade
        // era o agente levantando PRs e branches repo a repo — trabalho de máquina, não de julgamento.
        this.avisar({
            tipo: 'agente', fase: 'andando', chamado, passo: 0,
            texto: `modelo ${MODELO_DA_SESSAO()} · esforço high — levantando PRs e branches dos repos…`
        });
        this._inventario(chamado).then(inventario => this._rodarAgente(chamado, inventario, inicio));
    }

    async _inventario(chamado) {
        const repos = this._reposDoChamado(chamado);
        const blocos = await Promise.all(repos.map(async projeto => {
            const raiz = join(WORKSPACE, projeto);
            const campos = 'number,state,headRefName,baseRefName,updatedAt,title';
            const gh = args => execFileAsync('gh', ['pr', 'list', ...args, '--state', 'all', '--limit', '20', '--json', campos],
                { cwd: raiz, encoding: 'utf8' }).then(r => JSON.parse(r.stdout || '[]'));
            const branches = await execFileAsync('git', ['-C', raiz, 'branch', '-a', '--list', `*${chamado}*`, '--format=%(refname:short)'],
                { encoding: 'utf8' }).then(r => r.stdout.trim().split('\n').filter(Boolean)).catch(() => []);
            // Duas buscas, porque uma só mente: `in:title` NÃO devolveu a PR #134 do jungle-monorepo
            // (título com o ID e tudo), e a corrida decidiu `--stage` num repo mesclado. Por head
            // acha o que a busca de texto perde; a busca de texto acha PR de branch com outro nome.
            const heads = [...new Set(branches.map(b => b.replace(/^origin\//, '')))];
            const listas = await Promise.all([
                gh(['--search', `${chamado} in:title`]).catch(() => null),
                ...heads.map(h => gh(['--head', h]).catch(() => []))
            ]);
            const prs = listas[0] === null && listas.slice(1).every(l => !l.length) ? null
                : [...new Map(listas.flat().filter(Boolean).map(p => [p.number, p])).values()]
                    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            const linhasPr = prs === null ? '  (gh falhou neste repo — decida pelo que souber ou use --stage)'
                : prs.length ? prs.map(p => `  PR #${p.number} ${p.state} ${p.headRefName} → ${p.baseRefName} (${p.updatedAt.slice(0, 10)}) ${p.title.slice(0, 70)}`).join('\n')
                    : '  (nenhuma PR com o ID no título)';
            return `### ${projeto}\n${linhasPr}\n  branches locais: ${branches.join(', ') || '(nenhuma)'}`;
        }));
        return blocos.join('\n\n');
    }

    _rodarAgente(chamado, inventario, inicio, promptPronto = null) {
        const filho = spawn('claude', [
            '-p', promptPronto || PROMPT_COMPARACAO(chamado, inventario),
            // `high` fixo, não o default da sessão: a tarefa é julgamento (desempatar PRs do mesmo dia,
            // ver se um commit local já entrou por squash) e `xhigh`/`max` não melhoraram isso — só
            // esticam a corrida, que a pessoa está olhando esperar.
            '--effort', 'high',
            '--output-format', 'stream-json', '--verbose', '--max-turns', '60',
            '--allowedTools', 'Bash(node:*)', 'Bash(gh:*)', 'Bash(curl:*)', 'Bash(cd:*)', 'Read', 'Grep', 'Glob'
        ], {
            cwd: WORKSPACE,
            stdio: ['ignore', 'pipe', 'pipe'],
            // O hook lê isto para NÃO injetar a rotina de fim: a corrida é uma tarefa fechada.
            env: { ...process.env, QUALIDADE_AGENTE: chamado }
        });

        let resto = '';
        let ultimoTexto = '';
        let passos = 0;
        // A execução inteira, gravada: o painel da aba guardava 120 linhas truncadas e sumia no
        // reload — e "o que o agente fez" é justamente o que se quer reler depois, não o resumo.
        const corrida = {
            chamado, modelo: MODELO_DA_SESSAO(), esforco: 'high',
            inicio: new Date().toISOString(), eventos: []
        };
        this.corridaViva = corrida;
        filho.stdout.on('data', pedaco => {
            resto += pedaco.toString();
            const linhas = resto.split('\n');
            resto = linhas.pop() || '';
            for (const linha of linhas) {
                const evento = this._doStream(linha);
                if (!evento) {
                    continue;
                }
                passos++;
                this.agentePassos = passos;
                ultimoTexto = evento.texto || ultimoTexto;
                corrida.eventos.push({ passo: passos, em: new Date().toISOString(), ...evento });
                this.avisar({ tipo: 'agente', fase: 'andando', chamado, passo: passos, ...evento });
            }
        });
        let erro = '';
        filho.stderr.on('data', p => { erro += p.toString().slice(0, 2000); });
        filho.on('error', e => {
            this.agenteRodando = null;
            this.agenteFim = { chamado, em: Date.now(), ok: false, passos };
            this.avisar({ tipo: 'agente', fase: 'fim', chamado, ok: false, texto: `não consegui rodar o claude: ${e.message}` });
        });
        filho.on('close', codigo => {
            this.agenteRodando = null;
            this.corridaViva = null;
            this.agenteFim = { chamado, em: Date.now(), ok: codigo === 0, passos };
            const segundos = Math.round((Date.now() - inicio) / 1000);
            this.registrar('agente', codigo === 0 ? 'fim' : 'erro', `${chamado} em ${segundos}s`);
            // O cache cai depois do agente: as decisões novas mudam base, alvo e as checagens.
            this.invalidar({ chamado, silencioso: true });
            this.avisar({ tipo: 'agente', fase: 'andando', chamado, passo: passos + 1, texto: 'conferindo os números contra as PRs…' });
            corrida.fim = new Date().toISOString();
            corrida.segundos = segundos;
            corrida.ok = codigo === 0;
            corrida.resumo = ultimoTexto || null;
            corrida.erro = codigo === 0 ? null : (erro.trim().split('\n')[0] || `código ${codigo}`);
            // A conferência de números é da corrida de COMPARAÇÃO: na implantação não há PR para
            // comparar contra, e rodar `gh pr view` de decisão nenhuma só atrasaria o fim.
            const conferir = chamado === 'implantação' ? Promise.resolve([]) : this._conferirDecisoes(chamado);
            conferir.then(divergentes => {
                corrida.divergentes = divergentes;
                this.gravarCorrida(corrida);
                const resumo = divergentes.length
                    ? `${divergentes.length} não bateu: ${divergentes.join(' · ')}`
                    : 'todos os números batem com as PRs';
                this.avisar({
                    tipo: 'agente', fase: 'fim', chamado, ok: codigo === 0 && !divergentes.length, segundos,
                    texto: codigo === 0 ? `${ultimoTexto || 'terminou'} — ${resumo}` : (erro.trim().split('\n')[0] || `saiu com código ${codigo}`)
                });
            });
        });
    }

    // Todas as corridas ficam gravadas, não só a última: o arquivo por chamado sobrescrevia a
    // anterior a cada rodada, e "o que o agente fez antes" era justamente o que se queria reler.
    gravarCorrida(corrida) {
        try {
            corridas.gravar(corrida);
        } catch (e) {
            this.registrar('agente', 'log-falhou', e.message);
        }
    }

    corridaDe(chamado) {
        // Em memória primeiro: durante a corrida o banco ainda não tem o fim nem os últimos passos.
        if (this.corridaViva?.chamado === chamado) {
            return { ...this.corridaViva, rodando: true };
        }
        try {
            return corridas.ultima(chamado);
        } catch {
            return null;
        }
    }

    // Depois da corrida, o servidor confere o que o agente decidiu: nº de arquivos da PR (gh) contra o
    // que a tela mostra com a decisão. Era o agente que fazia isso, a 2 comandos por repo.
    async _conferirDecisoes(chamado) {
        const divergentes = [];
        for (const d of comparacao.listar(chamado)) {
            if (d.via !== 'pr') {
                continue;
            }
            try {
                const { stdout } = await execFileAsync('gh', ['pr', 'view', String(d.pr), '--json', 'files', '-q', '.files | length'],
                    { cwd: join(WORKSPACE, d.projeto), encoding: 'utf8' });
                const naPr = Number(stdout.trim());
                const tela = this.listaDeArquivos(d.projeto, null, d.branch || '', chamado).arquivos.length;
                if (naPr !== tela) {
                    divergentes.push(`${d.projeto}: PR #${d.pr} tem ${naPr}, tela mostra ${tela}`);
                }
            } catch {
                divergentes.push(`${d.projeto}: não consegui conferir a PR #${d.pr}`);
            }
        }
        return divergentes;
    }

    // Uma linha do stream-json em algo que caiba numa tela: ferramenta usada ou texto do assistente.
    _doStream(linha) {
        let e;
        try {
            e = JSON.parse(linha);
        } catch {
            return null;
        }
        if (e.type === 'assistant') {
            for (const parte of e.message?.content || []) {
                if (parte.type === 'text' && parte.text.trim()) {
                    return { texto: parte.text.trim().slice(0, 4000) };
                }
                if (parte.type === 'tool_use') {
                    const cmd = parte.input?.command || parte.input?.file_path || parte.name;
                    return { ferramenta: parte.name, texto: String(cmd).slice(0, 1200) };
                }
            }
            return null;
        }
        if (e.type === 'system' && e.subtype === 'init') {
            return { texto: 'sessão do agente iniciada' };
        }
        if (e.type === 'result') {
            return { texto: String(e.result || '').trim().slice(0, 4000) };
        }
        return null;
    }

    // Chamado 100% resolvido e parado há 3 dias vai sozinho para os ocultos, com rastro no log. Sem
    // isto ele fica na barra até alguém clicar no ×, e a barra é para o que está acontecendo. O ↩
    // traz de volta, e trazer de volta segura por mais 3 dias (o `mostrar` grava a data).
    arquivarResolvidos(lista) {
        const limite = Date.now() - 3 * 24 * 3600 * 1000;
        for (const c of lista) {
            if (this.ocultos.has(c.chamado) || !c.repos.length) {
                continue;
            }
            const todosResolvidos = c.repos.every(r => r.situacao === 'resolvido');
            const parado = (c.ultimaData ? Date.parse(c.ultimaData) : Date.now()) < limite;
            const trazidoDeVolta = (this.mostradosEm[c.chamado] || 0) > limite;
            if (todosResolvidos && parado && !trazidoDeVolta) {
                this.ocultos.add(c.chamado);
                this.registrar('ocultar', 'automatico', `${c.chamado} 100% resolvido, parado desde ${c.ultimaData.slice(0, 10)}`);
                this.gravarOcultos();
            }
        }
    }

    // A branch de fato comparada pode não ser a que tem o nome do chamado: quando a decisão é por
    // uma PR, é a branch DELA. E `decididos` é o que separa "calculado" de "no palpite".
    enriquecerDecisoes(lista) {
        const decisoes = comparacao.atuais();
        for (const c of lista) {
            for (const r of c.repos) {
                const dec = decisoes[`${c.chamado}|${r.projeto}`];
                r.branch = dec?.branch || c.chamado;
                r.situacao = dec?.situacao || null;
                r.pr = dec?.pr || null;
                r.decididoEm = dec?.em || null;
                // A decisão inteira: a modal do estado mostra via, destino, nota e quando, repo a repo.
                r.decisao = dec ? {
                    via: dec.via, pr: dec.pr ?? null, destino: dec.destino ?? null, base: dec.base ?? null,
                    branch: dec.branch ?? null, nota: dec.nota ?? null, em: dec.em ?? null, situacao: dec.situacao
                } : null;
            }
            c.decididos = c.repos.filter(r => r.situacao).length;
            c.calculadoEm = c.repos.map(r => r.decididoEm).filter(Boolean).sort().pop() || null;
        }
    }

    // O IP da rede, para o link impresso ser clicável de outra máquina em vez de dizer 0.0.0.0.
    ipDaRede() {
        for (const lista of Object.values(networkInterfaces())) {
            for (const i of lista || []) {
                if (i.family === 'IPv4' && !i.internal) {
                    return i.address;
                }
            }
        }
        return null;
    }

    // Varre a pasta em vez de uma lista de nomes: asset fora dela não entrava no maior mtime, e a
    // tela seguia servindo o app.js velho do cache do navegador depois de ele ser partido em dois.
    versaoDosAssets() {
        let maior = 0;
        try {
            for (const nome of readdirSync(join(import.meta.dirname, 'web'))) {
                if (!/\.(css|js|mjs|svg|ico|png|webmanifest)$/.test(nome)) {
                    continue;
                }
                maior = Math.max(maior, statSync(join(import.meta.dirname, 'web', nome)).mtimeMs);
            }
        } catch {
            // pasta ausente não impede a página de subir
        }
        return String(Math.round(maior));
    }

    // Sem laço por arquivo: o Diff.listarArquivos já traz +/- de todos numa chamada só.
    listaDeArquivos(projeto, base, ref = '', chamado = null) {
        const { diff: d, base: baseReal, via, decisao, erroDaDecisao } = comparacao.resolver(projeto, ref, base, chamado);
        return {
            projeto, branch: d.branch(), base: baseReal,
            baseNome: d.baseNome || null, mesclado: Boolean(d.mesclado),
            comoSoube: d.comoSoube || null,
            via, erroDaDecisao: erroDaDecisao || null,
            naoRastreados: d.naoRastreados(),
            decisao: decisao ? { pr: decisao.pr ?? null, branch: decisao.branch, estado: decisao.estado ?? null } : null,
            arquivos: d.listarArquivos(baseReal)
        };
    }

    rotear(req, res) {
        const url = new URL(req.url, `http://localhost:${PORTA}`);
        const q = url.searchParams;

        // CSS/JS/ícone da própria tela ficam fora do token: eles não carregam dado nem capacidade, e
        // a URL deles vem do HTML sem o `?t=` — pedir token ali dava 401 no `app.js`, o app nunca
        // iniciava e a tela ficava carregando para sempre. `/` e todo `/api/` seguem exigindo.
        // `.ico` e `.png` entram: o navegador pede `/favicon.ico` como reserva por conta própria, e
        // 401 nele faz o ícone da aba cair no genérico. A resposta honesta ali é 404, não 401.
        const ehAsset = /^\/[\w-]+\.(css|js|svg|ico|png|webmanifest)$/.test(url.pathname);
        // Quem chega de 127.0.0.1 não precisa de token: o token existe para a REDE, e exigi-lo no
        // localhost só quebrava o `http://localhost:4100/` de sempre ao expor a tela.
        if (TOKEN && !ehAsset && !ehLocal(req.socket.remoteAddress)) {
            const dado = q.get('t') || req.headers['x-qualidade-token'] || '';
            // Comparação de tamanho fixo: `===` em string vaza o tamanho do prefixo comum pelo tempo.
            const ok = dado.length === TOKEN.length
                && timingSafeEqual(Buffer.from(dado), Buffer.from(TOKEN));
            if (!ok) {
                this.registrar('acesso', 'negado', `${req.socket.remoteAddress} ${url.pathname}`);
                res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
                return res.end('token inválido — abra a tela com ?t=<QUALIDADE_TOKEN>');
            }
        }

        if (url.pathname === '/') {
            // O token volta embutido na página: quem chegou com `?t=` já provou que tem, e as
            // chamadas seguintes o levam sozinhas — sem cookie e sem sessão para manter.
            const corpo = pagina(this.qualidade.esqueleto(), this.versaoDosAssets(),
                TOKEN ? q.get('t') || '' : '', ehLocal(req.socket.remoteAddress), linear.workspace());
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            return res.end(corpo);
        }
        // Só nome simples dentro de web/: sem barra e sem `..`, para o caminho não escapar da pasta.
        if (/^\/[\w-]+\.(css|js|svg|ico|png)$/.test(url.pathname)) {
            const tipos = { css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml',
                ico: 'image/x-icon', png: 'image/png' };
            try {
                const corpo = readFileSync(join(import.meta.dirname, 'web', url.pathname.slice(1)));
                res.writeHead(200, {
                    'content-type': `${tipos[url.pathname.split('.').pop()]}; charset=utf-8`,
                    'cache-control': 'no-store'
                });
                return res.end(corpo);
            } catch {
                res.writeHead(404, { 'content-type': 'text/plain' });
                return res.end('não encontrado');
            }
        }
        if (url.pathname === '/api/agente-log') {
            // Com `id`, uma corrida antiga do histórico; sem ele, a última do chamado — que é o que
            // a tela pede desde sempre e continua recebendo na mesma forma.
            const corrida = q.get('id') ? corridas.obter(Number(q.get('id'))) : this.corridaDe(q.get('chamado'));
            return this.json(res, corrida || { chamado: q.get('chamado'), eventos: [] });
        }
        // Sem os eventos, que são dezenas por corrida: esta rota é para escolher qual abrir, e quem
        // quer os passos pede `/api/agente-log?id=`.
        if (url.pathname === '/api/agente-historico') {
            return this.json(res, {
                corridas: corridas.historico(q.get('chamado'), Number(q.get('limite')) || 20)
            });
        }
        if (url.pathname === '/api/implantacao') {
            // Só a contagem: quem está à frente. O TTL é curto porque a fila muda a cada merge.
            return this.emCacheAsync('implantacao', async () => ({
                fila: await implantacao.resumo(),
                escolhidos: implantacao.escolhidos(),
                // Sem isto o painel não tinha como distinguir "nada mudou" de "ninguém buscou": os
                // dois desenham a mesma fila, e só um deles é notícia.
                buscadoEm: implantacao.buscadoEm()
            }), 60000).then(v => this.json(res, v));
        }
        if (url.pathname === '/api/implantacao-detalhe') {
            const projeto = q.get('projeto');
            return this.emCacheAsync(`impl|${projeto}`,
                () => implantacao.detalhe(projeto).then(d => d || { projeto, erro: 'sem origin/main ou origin/stage' }),
                60000).then(v => this.json(res, v));
        }
        if (url.pathname === '/api/repos') {
            return this.json(res, { repos: implantacao.catalogo.listar(), detectadoEm: implantacao.catalogo.detectadoEm() });
        }
        if (url.pathname === '/api/repos-detectar') {
            // Detectar é leitura do `.git` local — não vai à rede e não escreve em repo nenhum,
            // só no catálogo daqui. Por isso não tem a trava de localhost do fetch e da corrida.
            return implantacao.catalogo.detectar()
                .then(lista => {
                    this.registrar('repos', 'detectar', `${lista.filter(r => r.ativo).length} de ${lista.length} com par`);
                    this.invalidarImplantacao();
                    return this.json(res, { repos: lista, detectadoEm: implantacao.catalogo.detectadoEm() });
                })
                .catch(e => this.json(res, { erro: e.message }, 500));
        }
        if (url.pathname === '/api/repos-salvar' && req.method === 'POST') {
            return this.salvarRepos(req, res);
        }
        if (url.pathname === '/api/implantacao-atualizar') {
            return this.atualizarImplantacao(res, req.socket.remoteAddress);
        }
        if (url.pathname === '/api/implantacao-escolher') {
            // Duas formas, de propósito. `entra`/`sai` nomeiam UM repo e são idempotentes: repetir o
            // pedido não muda mais nada. `projetos` manda o conjunto inteiro e é destrutivo por
            // natureza — quem repete um pedido velho apaga o que veio depois.
            //
            // A lista de marcar/desmarcar usa a primeira. Um clique repetido pelo navegador contra a
            // lista que se redesenha já apagou a escolha três vezes aqui: mandando o conjunto, cada
            // repetição acertava a PRIMEIRA linha restante e ia comendo os repos um a um; mandando o
            // nome, a repetição não faz nada.
            const entra = q.get('entra');
            const sai = q.get('sai');
            const escolhidos = new Set(implantacao.escolhidos());
            if (entra || sai) {
                if (entra) {
                    escolhidos.add(entra);
                }
                if (sai) {
                    escolhidos.delete(sai);
                }
            } else {
                escolhidos.clear();
                for (const p of (q.get('projetos') || '').split(',').filter(Boolean)) {
                    escolhidos.add(p);
                }
            }
            const projetos = [...escolhidos];
            implantacao.escolher(projetos);
            this.registrar('implantacao', 'escolha',
                `${entra ? `+${entra}` : ''}${sai ? `-${sai}` : ''}${entra || sai ? ' → ' : ''}${projetos.join(',') || '(nenhum)'}`);
            this.cache.delete('implantacao');
            return this.json(res, { escolhidos: projetos });
        }
        if (url.pathname === '/api/implantacao-pr') {
            // Só de localhost, como a corrida: abrir PR é ação para fora, e a confirmação está na
            // tela. O corpo vem do detalhe, não do cliente — texto de PR montado pelo navegador
            // seria conteúdo não conferido indo para o repositório.
            if (!ehLocal(req.socket.remoteAddress)) {
                return this.json(res, { ok: false, erro: 'abrir PR só da máquina do servidor' });
            }
            return this.abrirPrDeRelease(q.get('projeto'), res);
        }
        if (url.pathname === '/api/agente-implantacao') {
            return this.agenteImplantacao((q.get('projetos') || '').split(',').filter(Boolean),
                res, req.socket.remoteAddress);
        }
        if (url.pathname === '/api/agente') {
            return this.agente(q.get('chamado'), res, req.socket.remoteAddress);
        }
        if (url.pathname === '/api/eventos') {
            return this.eventos(req, res);
        }
        if (url.pathname === '/api/invalidar') {
            return this.json(res, this.invalidar({
                projeto: q.get('projeto'),
                chamado: q.get('chamado'),
                silencioso: q.get('silencioso') === '1'
            }));
        }
        if (url.pathname === '/api/chamados') {
            return this.emCacheAsync('chamados', async () => {
                const lista = await this.workspace.chamados();
                // Cópia crua ao lado do cache: o `emCacheAsync` guarda uma PROMESSA, e a
                // invalidação por chamado é sync — lendo `valor.lista` ela achava `undefined` e
                // deixava de derrubar os repos do chamado, sem erro nenhum.
                this.ultimaLista = lista;
                // O título vem do cache do Linear: a barra mostrando só `UND-1638` não diz nada.
                // É leitura de arquivo local, então cabe aqui.
                for (const c of lista) {
                    c.titulo = linear.doChamado(c.chamado)?.titulo || null;
                }
                return { lista };
            }, 30000).then(dados => this.responderChamados(res, dados));
        }
        // Sem cache: a pergunta é "o que está acontecendo AGORA", e a leitura do registro é
        // barata o bastante para não valer o risco de responder um estado velho.
        if (url.pathname === '/api/sessoes') {
            return this.json(res, q.get('detalhe') === '1' ? sessoes.detalhe() : sessoes.resumo());
        }
        if (url.pathname === '/api/ocultar') {
            // Deixa rastro: um chamado que sai do menu sem registro é impossível de explicar depois.
            this.registrar('ocultar', 'oculto', q.get('chamado'));
            this.ocultos.add(q.get('chamado'));
            this.gravarOcultos();
            return this.json(res, { ocultos: [...this.ocultos] });
        }
        if (url.pathname === '/api/mostrar') {
            this.registrar('mostrar', 'visivel', q.get('chamado') || '(todos)');
            const chamado = q.get('chamado');
            if (chamado) {
                this.ocultos.delete(chamado);
                this.mostradosEm[chamado] = Date.now();
            } else {
                this.ocultos.clear();
            }
            this.gravarOcultos();
            return this.json(res, { ocultos: [...this.ocultos] });
        }
        if (url.pathname === '/api/arquivos') {
            return this.json(res, this.emCache(`arquivos|${q.get('projeto')}|${q.get('ref') || ''}|${q.get('base') || ''}|${q.get('chamado') || ''}|${comparacao.versao}`,
                () => this.listaDeArquivos(q.get('projeto'), q.get('base'), q.get('ref') || '', q.get('chamado'))));
        }
        if (url.pathname === '/api/arquivo') {
            const chave = `arquivo|${q.get('projeto')}|${q.get('ref') || ''}|${q.get('caminho')}|${q.get('completo')}|${q.get('chamado') || ''}|${comparacao.versao}`;
            return this.json(res, this.emCache(chave, () => {
                const { diff: d, base } = comparacao.resolver(q.get('projeto'), q.get('ref') || '', q.get('base'), q.get('chamado'));
                return d.montarColunas(base, q.get('caminho'), {
                    completo: q.get('completo') === '1',
                    margem: Number(q.get('margem')) || 6
                });
            }));
        }
        if (url.pathname === '/api/configs') {
            return this.json(res, {
                configs: Object.entries(CONFIGS).map(([chave, c]) => ({
                    chave, rotulo: c.rotulo, resumo: c.resumo, caminho: c.caminho
                }))
            });
        }
        if (url.pathname === '/api/config') {
            const c = CONFIGS[q.get('chave')];
            if (!c) {
                return this.json(res, { erro: 'chave desconhecida' }, 404);
            }
            // Rotina ainda não plantada é resposta, não erro: 500 aqui dizia "o servidor quebrou"
            // quando a verdade é "esse arquivo não existe nessa pasta ainda".
            const alvo = join(WORKSPACE, c.caminho);
            if (!existsSync(alvo)) {
                return this.json(res, {
                    chave: q.get('chave'), rotulo: c.rotulo, caminho: c.caminho, conteudo: '', existe: false
                });
            }
            try {
                return this.json(res, {
                    chave: q.get('chave'), rotulo: c.rotulo, caminho: c.caminho, existe: true,
                    conteudo: readFileSync(alvo, 'utf8')
                });
            } catch (e) {
                return this.json(res, { erro: e.message }, 500);
            }
        }
        if (url.pathname === '/api/config-salvar' && req.method === 'POST') {
            return this.salvarConfig(req, res);
        }
        if (url.pathname === '/api/primeira-vez') {
            return this.json(res, this.primeiraVez(q.get('raiz')));
        }
        if (url.pathname === '/api/primeira-vez-salvar' && req.method === 'POST') {
            return this.salvarPrimeiraVez(req, res);
        }
        if (url.pathname === '/api/prs') {
            const chamado = q.get('chamado');
            const projetos = (q.get('projetos') || '').split(',').filter(Boolean);
            return this.emCacheAsync(`prs|${chamado}|${projetos.join(',')}`,
                async () => ({
                    prs: await prs.doChamado(chamado, projetos),
                    linear: linear.doChamado(chamado)
                }))
                .then(r => this.json(res, r));
        }
        if (url.pathname === '/api/pontos') {
            return this.json(res, { pontos: this.pontos.para(q.get('chamado'), q.get('projeto')) });
        }
        if (url.pathname === '/api/ponto-remover') {
            const r = this.pontos.remover(q.get('id'));
            // Remoção deixa rastro: sem isso não há como responder depois quem tirou um ponto.
            this.registrar('ponto-remover', r.removidos ? 'removido' : 'nao-encontrado', q.get('id'));
            return this.json(res, r);
        }
        if (url.pathname === '/api/qualidade') {
            return this.json(res, this.emCache(`local|${q.get('projeto')}|${q.get('ref') || ''}|${q.get('chamado') || ''}|${comparacao.versao}`,
                () => {
                    // A mesma comparação do diff: base diferente aqui era o que fazia o cartão de
                    // cobertura discordar do que a tela mostrava logo abaixo dele.
                    const c = comparacao.resolver(q.get('projeto'), q.get('ref') || '', null, q.get('chamado'));
                    return this.qualidade.local(q.get('chamado'), q.get('projeto'), c.alvo, c.base);
                }));
        }
        if (url.pathname === '/api/qualidade-remoto') {
            return this.emCacheAsync(`remoto|${q.get('chamado')}|${q.get('projeto')}`,
                () => this.qualidade.remoto(q.get('chamado'), q.get('projeto')))
                .then(valor => this.json(res, valor));
        }
        if (url.pathname === '/api/lint') {
            return this.emCacheAsync(`lint|${q.get('projeto')}|${q.get('ref') || ''}|${q.get('chamado') || ''}|${comparacao.versao}`,
                () => this.lint(q.get('projeto'), q.get('ref') || '', q.get('chamado')))
                .then(r => this.json(res, r));
        }
        if (url.pathname === '/api/checagens') {
            const r = this.ferramenta('checar-diff.mjs', [q.get('projeto')]);
            return this.json(res, r);
        }
        if (url.pathname === '/api/contexto') {
            return this.ferramentaAsync('contexto.mjs', [q.get('chamado')]).then(r => this.json(res, r));
        }
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('não encontrado');
    }

    subir() {
        const servidor = createServer((req, res) => {
            try {
                this.rotear(req, res);
            } catch (e) {
                this.json(res, { erro: e.message }, 500);
            }
        });
        // Exposto sem `QUALIDADE_TOKEN`: sorteia um e imprime a URL pronta com ele, em vez de
        // recusar. O que não pode existir é rede aberta SEM token; escolher o token é conveniência.
        if (!SO_LOCAL && !TOKEN) {
            // Lembrado em disco: sorteado a cada start, o link de ontem morria e "token inválido"
            // era o que se via. `QUALIDADE_TOKEN` no .env continua ganhando deste arquivo.
            const guardado = join(import.meta.dirname, 'token.local');
            if (existsSync(guardado)) {
                TOKEN = readFileSync(guardado, 'utf8').trim();
            }
            if (!TOKEN) {
                TOKEN = randomBytes(16).toString('hex');
                writeFileSync(guardado, `${TOKEN}\n`, { mode: 0o600 });
                sorteado = true;
            }
        }
        servidor.listen(PORTA, HOST, () => {
            const alvo = SO_LOCAL ? 'localhost' : (this.ipDaRede() || HOST);
            // qualidade:ok comentario-bloco-longo
            // A porta ANUNCIADA é a que o SO deu, não a que se pediu: com `PORT=0` — que é como o
            // teste de tela sobe o seu próprio servidor sem colidir com outra suíte na mesma
            // máquina — `PORTA` vale 0, e imprimir isso é imprimir um endereço que não existe.
            const porta = servidor.address().port;
            console.log(`qualidade → http://${alvo}:${porta}/${TOKEN ? `?t=${TOKEN}` : ''}`
                + `   (workspace: ${WORKSPACE})`
                + (SO_LOCAL ? '' : `\n⚠  exposto na rede${sorteado ? ', token sorteado agora' : ''} —`
                    + ` /api/agente executa comando nesta máquina. Sem o ?t= a resposta é 401.`));
        });
    }
}

new Servidor().subir();

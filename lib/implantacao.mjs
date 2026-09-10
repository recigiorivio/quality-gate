// O que está em `stage` e ainda não foi para `main` — a fila de implantação, atravessando os repos.
//
// Dois passos, de propósito: `resumo()` é uma contagem por repo e responde quem está à frente;
// `detalhe(projeto)` é o caro e sai sob demanda, só para os repos que a pessoa escolher.
//
// A pergunta que a barra de chamados NÃO responde: ela olha o trabalho por chamado, e implantar é
// olhar por repo, o acumulado de vários chamados. Medido no workspace: 7 repos, 137 commits e 249
// arquivos esperando, de 11 chamados diferentes.
//
// A base é o merge-base, não `origin/main` cru: com dois pontos o diff mostraria também o que a
// `main` ganhou por fora (cherry-pick de correção urgente, que aqui é rotina) como se fosse remoção.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE } from './diff.mjs';
import { Repos } from './repos.mjs';

const execFileAsync = promisify(execFile);
const PADRAO_CHAMADO = /\b([A-Z]{2,5}-\d+)\b/g;
// `QUALIDADE_ESTADO` existe para o teste: a suíte apontava para o arquivo de produção e
// esvaziou a escolha de repos do usuário três vezes, mesmo restaurando no `finally` —
// restauração some junto quando o teste falha no meio. Isolar o diretório resolve na raiz.
const ESCOLHIDOS = join(process.env.QUALIDADE_ESTADO
    || dirname(dirname(fileURLToPath(import.meta.url))), 'implantacao.json');

export class Implantacao {
    constructor() {
        this.catalogo = new Repos();
    }

    async git(projeto, ...args) {
        try {
            const { stdout } = await execFileAsync('git', ['-C', join(WORKSPACE, projeto), ...args],
                { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
            return stdout.trim();
        } catch {
            return null;
        }
    }

    repos() {
        return readdirSync(WORKSPACE, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.name.startsWith('.') && existsSync(join(WORKSPACE, d.name, '.git')))
            .map(d => d.name);
    }

    // Passo BARATO: uma contagem por repo, só para saber quem está à frente. O detalhe (log,
    // numstat, IDs, migrates) é caro e sai por repo, sob demanda — o workspace tem 22 repos com
    // stage à frente, um deles com 563 commits, e calcular todos de uma vez é trabalho jogado fora.
    // O par de branches é por REPO, do catálogo — não mais `origin/main...origin/stage` fixo. Era
    // esse nome chumbado que fazia 20 das 51 pastas caírem fora em silêncio, 5 delas por engano.
    // Os parâmetros continuam existindo para forçar um par igual em todos, que é o que os testes
    // usam para fabricar o caso de "zero commits".
    async resumo(destinoForcado = null, origemForcada = null) {
        const escolhidos = new Set(this.escolhidos());
        const alvos = destinoForcado && origemForcada
            ? this.repos().map(projeto => ({ projeto, destino: destinoForcado, origem: origemForcada }))
            : this._alvosDoCatalogo(escolhidos);
        const achados = await Promise.all(alvos.map(async ({ projeto, destino, origem }) => {
            const contagem = await this.git(projeto, 'rev-list', '--left-right', '--count',
                `${destino}...${origem}`);
            if (!contagem) {
                return null;
            }
            const [atras, afrente] = contagem.split(/\s+/).map(Number);
            // Repo ESCOLHIDO que zerou continua na lista, marcado. Sumir em silêncio é
            // indistinguível de "a ferramenta perdeu minha seleção", e o que houve foi o oposto: a
            // release entrou. Depois do primeiro `git fetch` os 5 escolhidos zeraram de uma vez e a
            // tela mostrou "0 de 9 repos — escolha os repos" com o crachá dizendo 5/9.
            if (!afrente && !escolhidos.has(projeto)) {
                return null;
            }
            return { projeto, commits: afrente, atras, destino, origem, implantado: !afrente };
        }));
        return achados.filter(Boolean).sort((a, b) => b.commits - a.commits);
    }

    // Os ativos do catálogo, mais qualquer escolhido que tenha par mas esteja desligado: desligar
    // um repo não pode fazer sumir uma escolha que a pessoa já tinha feito, sem aviso.
    _alvosDoCatalogo(escolhidos) {
        const ativos = this.catalogo.ativos();
        const dentro = new Set(ativos.map(r => r.projeto));
        const extras = this.catalogo.listar()
            .filter(r => escolhidos.has(r.projeto) && !dentro.has(r.projeto) && r.origem && r.destino);
        return [...ativos, ...extras];
    }

    // O caro, de um repo só: o que de fato entra na implantação.
    async detalhe(projeto, destinoForcado = null, origemForcada = null) {
        const par = this.catalogo.par(projeto);
        const destino = destinoForcado || par?.destino || 'origin/main';
        const origem = origemForcada || par?.origem || 'origin/stage';
        const base = await this.git(projeto, 'merge-base', destino, origem);
        if (!base) {
            return null;
        }
        const bruto = await this.git(projeto, 'log', `${base}..${origem}`,
            '--format=%h%x01%an%x01%cI%x01%p%x01%s');
        // Zero commits é RESPOSTA, não falha: o repo já está implantado. Devolver `null` aqui fazia
        // o servidor responder "sem origin/main ou origin/stage" — um erro de configuração, para
        // quem só tinha acabado de mesclar tudo.
        if (bruto === null) {
            return null;
        }
        // Os pais vêm junto porque a tela deixa clicar num commit para ver só o diff DELE, e o diff
        // de um commit é contra o pai. Vir de `%p` e não de `hash~1` cobre os dois casos em que a
        // conta falharia: commit raiz (sem pai, não há diff a pedir) e merge (2 pais, e o primeiro é
        // o que diz o que o merge trouxe). `%p` antes de `%s` porque o assunto é texto livre.
        const commits = bruto.split('\n').filter(Boolean).map(l => {
            const [hash, autor, data, pais, ...resto] = l.split('\x01');
            return { hash, autor, data, titulo: resto.join('\x01'), pais: pais ? pais.split(' ') : [] };
        });
        const nomes = await this.git(projeto, 'diff', '--numstat', base, origem, '--');
        const arquivos = (nomes || '').split('\n').filter(Boolean).map(l => {
            const [mais, menos, ...resto] = l.split('\t');
            return { caminho: resto[resto.length - 1], adicionadas: Number(mais) || 0, removidas: Number(menos) || 0 };
        });
        const ids = [...new Set(commits.flatMap(c => c.titulo.match(PADRAO_CHAMADO) || []))].sort();
        return {
            projeto, base, destino, origem,
            commits: commits.length,
            listaDeCommits: commits,
            arquivos: arquivos.length,
            adicionadas: arquivos.reduce((s, a) => s + a.adicionadas, 0),
            removidas: arquivos.reduce((s, a) => s + a.removidas, 0),
            ids,
            autores: [...new Set(commits.map(c => c.autor))],
            // Sinais que mudam o peso da implantação e que ninguém lembra de procurar na pressa.
            migrates: arquivos.filter(a => /migrations?\//i.test(a.caminho)).map(a => a.caminho),
            pacote: arquivos.some(a => /(^|\/)package\.json$/.test(a.caminho)),
            // `desde`/`ate` não: o cache do servidor acrescenta um `desde` próprio (o instante em
            // que guardou) e sobrescreveria estes. Nome colidido é bug silencioso — este virou
            // "d.desde.slice is not a function" só porque o navegador reclamou.
            primeiroCommit: commits.length ? commits[commits.length - 1].data : null,
            ultimoCommit: commits.length ? commits[0].data : null
        };
    }

    // `origin/main` e `origin/stage` são cópias LOCAIS: elas só mudam com `git fetch`, e a fila
    // inteira é lida delas. Sem isto a tela mostrava dado velho com cara de novo — medido em
    // 10/09/2026, `stage` em dia nos 5 repos escolhidos e `main` atrasada nos 5, o que infla o que
    // "entra" (o merge-base fica atrás, e commit que já foi para a main continua contando).
    //
    // Um `git fetch` por REF, não os dois na mesma chamada: nomear os dois faz o git abortar
    // inteiro quando um não existe no remoto. O `item-loader` não tem `stage` lá, e a chamada única
    // deixava a `main` dele sem atualizar junto — em silêncio, que é o modo de falha que dói aqui.
    //
    // Busca todos os repos, não só os escolhidos: repo com 0 commits à frente não está na fila, e
    // é justamente ele que vira candidato novo ao receber o primeiro. Custa 2,4 s para 51 repos em
    // paralelo, e é um clique explícito com indicador na tela — não um custo por abertura.
    async buscarRemoto(segundos = 25) {
        const pares = new Map(this.catalogo.listar()
            .filter(r => r.origem && r.destino).map(r => [r.projeto, r]));
        const achados = await Promise.all(this.repos().map(async projeto => {
            const par = pares.get(projeto);
            // Repo fora do catálogo ainda é buscado no par padrão: é assim que ele ganha os refs
            // que a próxima detecção precisa ver para descobrir qual é o par dele.
            const refs = [...new Set([par?.destino || 'origin/main', par?.origem || 'origin/stage']
                .map(r => r.replace(/^origin\//, '')))];
            const erros = [];
            await Promise.all(refs.map(async ref => {
                try {
                    await execFileAsync('git', ['-C', join(WORKSPACE, projeto),
                        'fetch', '--quiet', '--no-tags', 'origin', ref], { timeout: segundos * 1000 });
                } catch (e) {
                    erros.push(`${ref}: ${String(e.message).split('\n').pop().trim().slice(0, 90)}`);
                }
            }));
            return { projeto, ok: erros.length < refs.length, erros, refs };
        }));
        const buscadoEm = new Date().toISOString();
        this._gravar({ buscadoEm });
        return { buscadoEm, repos: achados.length, achados };
    }

    // A escolha de repos fica em disco: implantação é uma sessão de trabalho que atravessa
    // reinícios, e refazer a seleção de 22 repos a cada abertura seria o próprio trabalho de novo.
    // O arquivo é lido-e-mesclado, nunca sobrescrito inteiro: `escolher` e `buscarRemoto` gravam
    // campos diferentes do mesmo JSON, e escrever o objeto todo apagava o campo do outro.
    _estado() {
        try {
            return JSON.parse(readFileSync(ESCOLHIDOS, 'utf8'));
        } catch {
            return {};
        }
    }

    _gravar(mudanca) {
        const novo = { ...this._estado(), ...mudanca };
        writeFileSync(ESCOLHIDOS, `${JSON.stringify(novo, null, 2)}\n`);
        return novo;
    }

    escolhidos() {
        return this._estado().projetos || [];
    }

    buscadoEm() {
        return this._estado().buscadoEm || null;
    }

    escolher(projetos) {
        this._gravar({ projetos, em: new Date().toISOString() });
        return projetos;
    }

    // Abre a PR de release. `gh` recusa sozinho se já existir uma com o mesmo head/base, então não
    // há duplicata a evitar aqui — o que se evita é abrir sem alguém pedir, e isso é da tela.
    async abrirPr(projeto, { destino = 'main', origem = 'stage', titulo, corpo }) {
        try {
            const { stdout } = await execFileAsync('gh',
                ['pr', 'create', '--base', destino, '--head', origem, '--title', titulo, '--body', corpo],
                { cwd: join(WORKSPACE, projeto), encoding: 'utf8' });
            return { ok: true, url: stdout.trim().split('\n').pop() };
        } catch (e) {
            const saida = `${e.stderr || ''}${e.stdout || ''}`.trim();
            const jaExiste = saida.match(/https:\/\/github\.com\S+/);
            return { ok: false, erro: saida.split('\n')[0] || e.message, url: jaExiste?.[0] || null };
        }
    }

    // A PR de release, se já existe. `gh` é rede: chamado à parte, para a fila aparecer sem esperar.
    async prAberta(projeto, destino = 'main', origem = 'stage') {
        const bruto = await this.git(projeto, 'rev-parse', '--git-dir');
        if (bruto === null) {
            return null;
        }
        try {
            const { stdout } = await execFileAsync('gh',
                ['pr', 'list', '--head', origem, '--base', destino, '--state', 'open',
                    '--json', 'number,url,title,createdAt', '--limit', '1'],
                { cwd: join(WORKSPACE, projeto), encoding: 'utf8' });
            return JSON.parse(stdout || '[]')[0] || null;
        } catch {
            return null;
        }
    }
}

export default new Implantacao();

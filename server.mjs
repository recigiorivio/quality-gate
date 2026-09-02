// Tela local para ver o diff das tarefas. Sem dependência: node:http puro.
// O diff é montado a cada requisição, então não existe arquivo temporário para envelhecer.
//
// uso: npm start   (ou node server.mjs)   →   http://localhost:4100

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { Diff, WORKSPACE } from './lib/diff.mjs';
import { Workspace } from './lib/workspace.mjs';
import { Qualidade } from './lib/qualidade.mjs';
import { Pontos } from './ferramentas/pontos.mjs';
import lint from './lib/lint.mjs';
import comparacao from './lib/comparacao.mjs';
import prs from './lib/prs.mjs';
import linear from './lib/linear.mjs';
import { pagina } from './web/pagina.mjs';

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

Grave a partir de /Users/recigiorivio/node_workspace, um comando por repo:
  node qualidade/ferramentas/comparacao.mjs definir ${chamado} <repo> --pr=<N> --nota="<por que, em uma frase>"
  ou  node qualidade/ferramentas/comparacao.mjs definir ${chamado} <repo> --stage

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

const PORTA = Number(process.env.PORT || 4100);
const execFileAsync = promisify(execFile);

// Allowlist por chave, nunca caminho vindo do cliente: é o que impede escrever fora daqui.
const CONFIGS = {
    inicio: {
        caminho: '.claude/commands/inicio-trabalho.md',
        rotulo: 'Rotina de início',
        resumo: 'O que conferir antes de planejar ou escrever código'
    },
    fim: {
        caminho: '.claude/commands/final-trabalho.md',
        rotulo: 'Rotina de fim',
        resumo: 'O que corrigir e o que conferir antes de entregar'
    },
    regras: {
        caminho: '.claude/docs/qualidade-de-codigo.md',
        rotulo: 'Regras de código',
        resumo: 'Comentários, estrutura, testes — as regras que as checagens cobram'
    }
};

// Chamado some do menu porque o usuario mandou, nunca porque o programa achou que era velho:
// "antigo" aqui e a branch parada, e branch parada e exatamente a que se esquece de terminar.
const ARQUIVO_OCULTOS = join(import.meta.dirname, 'ocultos.json');

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

    lerOcultos() {
        try {
            return existsSync(ARQUIVO_OCULTOS) ? JSON.parse(readFileSync(ARQUIVO_OCULTOS, 'utf8')) : [];
        } catch {
            return [];
        }
    }

    gravarOcultos() {
        writeFileSync(ARQUIVO_OCULTOS, JSON.stringify([...this.ocultos], null, 2));
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
    emCache(chave, calcular, ttl = 300000) {
        const guardado = this.cache.get(chave);
        if (guardado && Date.now() - guardado.quando < ttl) {
            return { ...guardado.valor, doCache: true, desde: guardado.quando };
        }
        const valor = calcular();
        this.cache.set(chave, { quando: Date.now(), valor });
        return { ...valor, doCache: false, desde: Date.now() };
    }

    // Versão assíncrona do cache, para o que é rede. Guarda a PROMESSA: duas requisições
    // simultâneas do mesmo dado esperam a mesma chamada em vez de disparar duas.
    async emCacheAsync(chave, calcular, ttl = 300000) {
        const guardado = this.cache.get(chave);
        if (guardado && Date.now() - guardado.quando < ttl) {
            const valor = await guardado.valor;
            return { ...valor, doCache: true, desde: guardado.quando };
        }
        const promessa = calcular();
        this.cache.set(chave, { quando: Date.now(), valor: promessa });
        try {
            const valor = await promessa;
            return { ...valor, doCache: false, desde: Date.now() };
        } catch (e) {
            this.cache.delete(chave);
            throw e;
        }
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
                writeFileSync(`${alvo}.bak`, readFileSync(alvo));
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
            appendFileSync(join(import.meta.dirname, 'gate.log'),
                `${new Date().toISOString()}\t${acao}\t${resultado}\t${String(detalhe).slice(0, 200)}\n`);
        } catch {
            // log é observabilidade, não pode derrubar a rota
        }
    }

    // Invalida por projeto, por chamado, ou tudo. Por chamado é o recorte que faltava: um chamado
    // toca vários repos, e derrubar só o que está aberto deixava os outros seis com dado velho.
    // Lê do cache; só varre o disco se a lista ainda não foi pedida uma vez.
    _reposDoChamado(chamado) {
        const guardado = this.cache.get('chamados');
        const lista = guardado?.valor?.lista ?? this.workspace.chamados();
        return (lista.find(x => x.chamado === chamado)?.repos || []).map(r => r.projeto);
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
    agente(chamado, res) {
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

    _rodarAgente(chamado, inventario, inicio) {
        const filho = spawn('claude', [
            '-p', PROMPT_COMPARACAO(chamado, inventario),
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
            this._conferirDecisoes(chamado).then(divergentes => {
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

    // Uma corrida por chamado, a última: histórico completo seria útil e ninguém pediu, e o arquivo
    // por chamado é o que deixa o reload da página (e o reinício do servidor) não perder nada.
    gravarCorrida(corrida) {
        try {
            mkdirSync(join(import.meta.dirname, 'corridas'), { recursive: true });
            writeFileSync(this._caminhoCorrida(corrida.chamado), `${JSON.stringify(corrida, null, 1)}\n`);
        } catch (e) {
            this.registrar('agente', 'log-falhou', e.message);
        }
    }

    _caminhoCorrida(chamado) {
        return join(import.meta.dirname, 'corridas', `${String(chamado).replace(/[^A-Za-z0-9-]/g, '')}.json`);
    }

    corridaDe(chamado) {
        // Em memória primeiro: durante a corrida o arquivo ainda não existe.
        if (this.corridaViva?.chamado === chamado) {
            return { ...this.corridaViva, rodando: true };
        }
        try {
            return JSON.parse(readFileSync(this._caminhoCorrida(chamado), 'utf8'));
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

    // O maior mtime entre os assets: muda quando qualquer um deles muda, e o navegador rebusca.
    versaoDosAssets() {
        let maior = 0;
        for (const nome of ['app.js', 'estilo.css', 'realce.js', 'pagina.mjs']) {
            try {
                maior = Math.max(maior, statSync(join(import.meta.dirname, 'web', nome)).mtimeMs);
            } catch {
                // asset ausente não impede a página de subir
            }
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

        if (url.pathname === '/') {
            const corpo = pagina(this.qualidade.esqueleto(), this.versaoDosAssets());
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            return res.end(corpo);
        }
        // Só nome simples dentro de web/: sem barra e sem `..`, para o caminho não escapar da pasta.
        if (/^\/[\w-]+\.(css|js|svg)$/.test(url.pathname)) {
            const tipos = { css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml' };
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
            return this.json(res, this.corridaDe(q.get('chamado')) || { chamado: q.get('chamado'), eventos: [] });
        }
        if (url.pathname === '/api/agente') {
            return this.agente(q.get('chamado'), res);
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
            const dados = this.emCache('chamados', () => {
                const lista = this.workspace.chamados();
                // O título vem do cache do Linear: a barra mostrando só `UND-1638` não diz nada.
                // É leitura de arquivo local, então cabe aqui.
                for (const c of lista) {
                    c.titulo = linear.doChamado(c.chamado)?.titulo || null;
                }
                return { lista };
            }, 30000);
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
            try {
                return this.json(res, {
                    chave: q.get('chave'), rotulo: c.rotulo, caminho: c.caminho,
                    conteudo: readFileSync(join(WORKSPACE, c.caminho), 'utf8')
                });
            } catch (e) {
                return this.json(res, { erro: e.message }, 500);
            }
        }
        if (url.pathname === '/api/config-salvar' && req.method === 'POST') {
            return this.salvarConfig(req, res);
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
        createServer((req, res) => {
            try {
                this.rotear(req, res);
            } catch (e) {
                this.json(res, { erro: e.message }, 500);
            }
        }).listen(PORTA, '127.0.0.1', () => {
            console.log(`qualidade → http://localhost:${PORTA}   (workspace: ${WORKSPACE})`);
        });
    }
}

new Servidor().subir();

// Tela local para ver o diff das tarefas. Sem dependência: node:http puro.
// O diff é montado a cada requisição, então não existe arquivo temporário para envelhecer.
//
// uso: npm start   (ou node server.mjs)   →   http://localhost:4100

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';
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
        const { diff: d, base: baseReal, via, decisao } = comparacao.resolver(projeto, ref, base, chamado);
        return {
            projeto, branch: d.branch(), base: baseReal,
            baseNome: d.baseNome || null, mesclado: Boolean(d.mesclado),
            comoSoube: d.comoSoube || null,
            via, decisao: decisao ? { pr: decisao.pr ?? null, branch: decisao.branch, estado: decisao.estado ?? null } : null,
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
                    // A branch de fato comparada pode não ser a que tem o nome do chamado: quando o
                    // agente decidiu por uma PR, é a branch DELA. O chip precisa dizer qual é.
                    for (const r of c.repos) {
                        const dec = comparacao.decisoes[`${c.chamado}|${r.projeto}`];
                        r.branch = dec?.branch || c.chamado;
                        r.situacao = dec?.situacao || null;
                        r.pr = dec?.pr || null;
                    }
                }
                return { lista };
            }, 30000);
            // Os ocultos saem aqui, e nao na varredura: o Workspace responde o que existe, e o
            // que se escolhe ver e decisao da tela. Trocar isso esconderia repo esquecido do
            // proprio calculo que existe para achar repo esquecido.
            return this.json(res, {
                ...dados,
                lista: dados.lista.filter(c => !this.ocultos.has(c.chamado)),
                ocultos: dados.lista.filter(c => this.ocultos.has(c.chamado)).map(c => c.chamado)
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
            } else {
                this.ocultos.clear();
            }
            this.gravarOcultos();
            return this.json(res, { ocultos: [...this.ocultos] });
        }
        if (url.pathname === '/api/arquivos') {
            return this.json(res, this.emCache(`arquivos|${q.get('projeto')}|${q.get('ref') || ''}|${q.get('base') || ''}|${q.get('chamado') || ''}`,
                () => this.listaDeArquivos(q.get('projeto'), q.get('base'), q.get('ref') || '', q.get('chamado'))));
        }
        if (url.pathname === '/api/arquivo') {
            const chave = `arquivo|${q.get('projeto')}|${q.get('ref') || ''}|${q.get('caminho')}|${q.get('completo')}|${q.get('chamado') || ''}`;
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
            return this.json(res, this.emCache(`local|${q.get('projeto')}|${q.get('ref') || ''}`,
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
            return this.emCacheAsync(`lint|${q.get('projeto')}|${q.get('ref') || ''}|${q.get('chamado') || ''}`,
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

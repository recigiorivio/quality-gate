// A aba Whiteboard: achar o quadro do chamado, ler pelo comando, sobreviver ao app fechado, ler o
// código dos trechos no commit do quadro e desenhar o documento. O comando é um script falso: a suíte
// não depende do app instalado.
//
// uso: npm test

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anexarTrechos, escolherQuadro, lerQuadro } from '../lib/whiteboard.mjs';
import { desenharFluxo, quadroParaHtml, localDoTrecho } from '../web/quadro.js';
import { recusarEstadoDeProducao } from './anteparo.mjs';

recusarEstadoDeProducao();

const pasta = mkdtempSync(join(tmpdir(), 'qualidade-whiteboard-'));
after(() => rmSync(pasta, { recursive: true, force: true }));

const sessao = (extra = {}) => ({
    sessionId: '11111111-2222-3333-4444-555555555555', version: 3, title: 'UND-2304: translate',
    createdAt: '2026-10-19T10:00:00Z', origin: { branch: 'UND-2304' }, repositoryName: 'crohc-server',
    repositoryPath: '/x/crohc-server', trashedAt: null, ...extra
});

const fluxo = {
    type: 'flow_diagram', title: 'De onde vem o idCliente',
    nodes: [
        { key: 'req', label: 'GET /translate', kind: 'terminal' },
        { key: 'jwt', label: 'JWT tem idCliente?', kind: 'decision' },
        { key: 'mongo', label: 'Busca o usuário', kind: 'process' },
        { key: 'ok', label: '200', kind: 'terminal' },
        { key: 'erro', label: '401', kind: 'terminal' }
    ],
    edges: [
        { from: 'req', to: 'jwt' }, { from: 'jwt', to: 'ok', label: 'sim' },
        { from: 'jwt', to: 'mongo', label: 'não' }, { from: 'mongo', to: 'erro' }
    ]
};

const documento = [
    { type: 'section', title: 'O quê / por quê', children: [
        { type: 'markdown', markdown: 'Usa o [`resolverIdCliente`](review-source:head/src/a.js#L24-L30) quando falta **idCliente**.' },
        { type: 'markdown', markdown: 'Devolve **401 `CLIENTE_NAO_SELECIONADO`** quando falta a claim `idCliente`. Em realm **sem o Cliente Selector**.' }
    ] },
    { type: 'section', title: 'Desenho', children: [fluxo, { type: 'callout', title: 'O que não muda', tone: 'info',
        children: [{ type: 'markdown', markdown: 'Produção segue igual.' }] }] },
    { type: 'code_peek', source: 'head/src/app/components/application/application.controller.js#L23-L30', caption: 'o mecanismo' },
    { type: 'software_map', mapVersionId: 'x' }
];

function comandoFalso(nome, corpo) {
    const caminho = join(pasta, nome);
    writeFileSync(caminho, `#!/bin/sh\n${corpo}\n`);
    chmodSync(caminho, 0o755);
    return caminho;
}

test('acha o quadro pela branch ou pelo título; o do repo aberto ganha do mais recente de outro repo', () => {
    const lista = [
        sessao({ sessionId: 'a', createdAt: '2026-10-19T09:00:00Z' }),
        sessao({ sessionId: 'b', createdAt: '2026-10-19T11:00:00Z', origin: {}, title: 'UND-2304 segunda versão' }),
        sessao({ sessionId: 'c', createdAt: '2026-10-19T12:00:00Z', trashedAt: '2026-10-19T12:30:00Z' }),
        sessao({ sessionId: 'd', createdAt: '2026-10-19T13:00:00Z', repositoryName: 'contas-service', repositoryPath: '/x/contas-service' })
    ];
    assert.equal(escolherQuadro(lista, { chamado: 'UND-2304', projeto: 'crohc-server' }).sessionId, 'b');
    assert.equal(escolherQuadro(lista, { chamado: 'UND-2304', projeto: 'migrate-mongo' }).sessionId, 'd',
        'repo do chamado sem quadro próprio cai para o mais recente do chamado, em qualquer repo');
    assert.equal(escolherQuadro(lista, { chamado: 'UND-9', projeto: 'crohc-server' }), null);
});

test('UND-23 não casa com o quadro do UND-2304', () => {
    const lista = [sessao({ origin: {}, title: 'UND-2304: translate' })];
    assert.equal(escolherQuadro(lista, { chamado: 'UND-23', projeto: 'crohc-server' }), null);
});

test('lê ao vivo pelo comando e guarda a leitura; com o app fechado, devolve a guardada', async () => {
    writeFileSync(join(pasta, 'lista.json'), JSON.stringify([sessao()]));
    writeFileSync(join(pasta, 'quadro.json'), JSON.stringify({ ...sessao(), document: documento }));
    process.env.QUALIDADE_WHITEBOARD = comandoFalso('wb-vivo',
        `case "$2" in session_list) cat "${pasta}/lista.json";; session_get) cat "${pasta}/quadro.json";; esac`);
    const vivo = await lerQuadro({ chamado: 'UND-2304', projeto: 'crohc-server' });
    assert.equal(vivo.estado, 'ao-vivo');
    assert.equal(vivo.quadro.document.length, documento.length);
    assert.equal(vivo.repo, 'crohc-server');
    assert.equal((await lerQuadro({ chamado: 'UND-2304', projeto: 'contas-service' })).repo, 'crohc-server',
        'aberto noutro repo do chamado, avisa de qual repo é o quadro');

    process.env.QUALIDADE_WHITEBOARD = comandoFalso('wb-fechado',
        'echo "Whiteboard \\`stable\\` is not running. No Whiteboard is running."; exit 1');
    const fechado = await lerQuadro({ chamado: 'UND-2304', projeto: 'crohc-server' });
    assert.equal(fechado.estado, 'app-fechado');
    assert.equal(fechado.quadro.version, 3);
    assert.ok(fechado.lidoEm);

    const semGuardado = await lerQuadro({ chamado: 'UND-9999', projeto: 'crohc-server' });
    assert.deepEqual(semGuardado, { estado: 'app-fechado', erro: null });
});

test('sem o comando instalado, e com chamado inválido, não quebra', async () => {
    process.env.QUALIDADE_WHITEBOARD = join(pasta, 'nao-existe');
    assert.equal((await lerQuadro({ chamado: 'UND-1', projeto: 'crohc-server' })).estado, 'sem-comando');
    assert.deepEqual(await lerQuadro({ chamado: '../etc', projeto: 'crohc-server' }), { estado: 'sem-quadro' });
    assert.deepEqual(await lerQuadro({ chamado: 'UND-1', projeto: '../x' }), { estado: 'sem-quadro' });
});

test('o documento vira HTML: markdown, aviso e o trecho sem código lido mostra arquivo e linhas', () => {
    const html = quadroParaHtml(documento);
    assert.match(html, /<h3 class="q-secao-titulo">O quê \/ por quê<\/h3>/);
    assert.match(html, /<code>resolverIdCliente<\/code>/);
    assert.doesNotMatch(html, /review-source:/);
    assert.match(html, /<b>401<\/b> <code>CLIENTE_NAO_SELECIONADO<\/code> quando falta a claim <code>idCliente<\/code>/);
    assert.match(html, /<b>sem o Cliente Selector<\/b>/);
    assert.doesNotMatch(html, /\*\*/);
    assert.match(html, /q-aviso q-tom-info/);
    assert.match(html, /<code class="q-peek-arquivo">src\/app\/components\/application\/application\.controller\.js<\/code><span class="q-peek-meta">linhas 23–30<\/span>/);
    assert.match(html, /software_map: só no app do Whiteboard/);
    assert.equal(localDoTrecho('base/src/x.js#L7'), 'src/x.js · linha 7');
});

test('trecho com código lido e bloco de código: numerados, com selo, realce e copiar', () => {
    const html = quadroParaHtml([
        { type: 'code_peek', source: 'head/src/a.js#L10-L11', caption: 'legenda',
            trecho: { repo: 'crohc-server', commit: 'abc12345', inicio: 10, fim: 11, linhas: ['const a = 1;', '<b>'] } },
        { type: 'code', caption: 'Linha do tempo', text: 'v1:5  v2:3\nlegenda\n' }
    ]);
    assert.match(html, /<details class="q-peek" open>/);
    assert.match(html, /<span class="q-peek-meta">crohc-server · linhas 10–11<\/span>/);
    assert.match(html, /<td class="q-num">10<\/td><td class="q-src">.*const/);
    assert.match(html, /<td class="q-num">11<\/td><td class="q-src">.*&lt;.*b.*&gt;/, 'o código é escapado');
    assert.doesNotMatch(html, /<td class="q-src"><b>/);
    assert.match(html, /<span class="q-selo">PLAIN<\/span><span class="q-codigo-titulo">Linha do tempo<\/span><span class="q-codigo-meta">2 linhas<\/span>/);
    assert.match(html, /onclick="copiarDoQuadro\(this\)"/);
});

test('o código do trecho vem do commit do quadro, no repo que tem o commit', async () => {
    const ws = mkdtempSync(join(pasta, 'ws-'));
    const outro = join(ws, 'outro-repo');
    mkdirSync(outro);
    const git = (...a) => execFileSync('git', ['-C', outro, ...a], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    mkdirSync(join(outro, 'src'));
    writeFileSync(join(outro, 'src/a.js'), 'linha 1\nlinha 2\nlinha 3\n');
    git('add', '.');
    git('commit', '-qm', 'x');
    const sha = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(outro, 'src/a.js'), 'mudou depois\n');
    const quadro = { pins: { repositoryId: 'principal', head: 'f'.repeat(40) }, document: [
        { type: 'code_peek', source: 'head/src/a.js#L2-L3', pins: { repositoryId: 'outro', head: sha } },
        { type: 'code_peek', source: 'head/src/a.js#L1', pins: { repositoryId: 'outro', head: '0'.repeat(40) } }
    ] };
    await anexarTrechos(quadro, null, { workspace: ws });
    assert.deepEqual(quadro.document[0].trecho.linhas, ['linha 2', 'linha 3'], 'lê do commit, não da árvore de trabalho');
    assert.equal(quadro.document[0].trecho.repo, 'outro-repo');
    assert.match(quadro.document[1].trecho.erro, /não está em nenhum repo/);
});

test('o fluxo desenha todos os nós e arestas, sem coordenada inválida', () => {
    const svg = desenharFluxo(fluxo);
    for (const no of fluxo.nodes) {
        assert.ok(svg.includes(no.label), `falta o nó ${no.label}`);
    }
    assert.equal((svg.match(/class="q-aresta/g) || []).length, fluxo.edges.length);
    assert.doesNotMatch(svg, /NaN|Infinity/);
    const caminhos = [...svg.matchAll(/class="q-aresta[^"]*" pathLength="1" d="([^"]+)"/g)].map(m => m[1]);
    assert.ok(caminhos.some(d => d.split('L').length >= 3), 'a aresta longa (jwt → ok) contorna em vez de atravessar');
});

test('ciclo no fluxo não trava e a aresta de volta também aparece', () => {
    const ciclo = { nodes: [{ key: 'a', label: 'a' }, { key: 'b', label: 'b' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] };
    const svg = desenharFluxo(ciclo);
    assert.equal((svg.match(/class="q-aresta/g) || []).length, 2);
    assert.doesNotMatch(svg, /NaN|Infinity/);
});

test('a animação só entra quando pedida', () => {
    assert.doesNotMatch(quadroParaHtml(documento), /--d:/);
    assert.match(quadroParaHtml(documento, { animar: true }), /q-anim[\s\S]*--d:\d+ms/);
});

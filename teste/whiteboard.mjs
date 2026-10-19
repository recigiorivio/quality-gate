// A aba Whiteboard: achar o quadro do chamado, ler pelo comando, sobreviver ao app fechado e desenhar
// o documento sem o código. O comando é um script falso: a suíte não depende do app instalado.
//
// uso: npm test

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escolherQuadro, lerQuadro } from '../lib/whiteboard.mjs';
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

test('acha o quadro pela branch ou pelo título, no repo certo, e o mais recente', () => {
    const lista = [
        sessao({ sessionId: 'a', createdAt: '2026-10-19T09:00:00Z' }),
        sessao({ sessionId: 'b', createdAt: '2026-10-19T11:00:00Z', origin: {}, title: 'UND-2304 segunda versão' }),
        sessao({ sessionId: 'c', createdAt: '2026-10-19T12:00:00Z', trashedAt: '2026-10-19T12:30:00Z' }),
        sessao({ sessionId: 'd', createdAt: '2026-10-19T13:00:00Z', repositoryName: 'contas-service', repositoryPath: '/x/contas-service' })
    ];
    assert.equal(escolherQuadro(lista, { chamado: 'UND-2304', projeto: 'crohc-server' }).sessionId, 'b');
    assert.equal(escolherQuadro(lista, { chamado: 'UND-2304', projeto: 'migrate-mongo' }), null);
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

test('o documento vira HTML sem o código: o trecho mostra só arquivo e linhas', () => {
    const html = quadroParaHtml(documento);
    assert.match(html, /<h3 class="q-secao-titulo">O quê \/ por quê<\/h3>/);
    assert.match(html, /<code>resolverIdCliente<\/code>/);
    assert.doesNotMatch(html, /review-source:/);
    assert.match(html, /<b>401<\/b> <code>CLIENTE_NAO_SELECIONADO<\/code> quando falta a claim <code>idCliente<\/code>/);
    assert.match(html, /<b>sem o Cliente Selector<\/b>/);
    assert.doesNotMatch(html, /\*\*/);
    assert.match(html, /q-aviso q-tom-info/);
    assert.match(html, /application\.controller\.js · linhas 23–30/);
    assert.match(html, /software_map: só no app do Whiteboard/);
    assert.equal(localDoTrecho('base/src/x.js#L7'), 'src/x.js · linha 7');
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

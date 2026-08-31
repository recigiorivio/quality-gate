// Smoke test do servidor e das ferramentas. Existe porque, num único dia de desenvolvimento, cinco
// quebras passaram em silêncio: uma função apagada numa reescrita, um método apagado ao substituir
// outro, uma flag ignorada depois de acrescentar outra, um nome de regra renomeado num lugar só, e
// uma cópia de função que fez a otimização virar regressão de 16×.
//
// Todas as cinco eram detectáveis batendo nas rotas e conferindo a forma da resposta.
//
// uso: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));
// Porta fixa e distinta da do app (4100): porta sorteada tornava impossível saber, olhando o
// terminal, se o que subiu era o servidor de verdade ou o do teste.
const PORTA = Number(process.env.PORTA_TESTE || 4199);
const BASE = `http://127.0.0.1:${PORTA}`;

let servidor;
let contexto = { chamado: null, projeto: null, ref: '', caminho: null };

async function pegar(rota, params = {}) {
    const url = new URL(rota, BASE);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) {
            url.searchParams.set(k, v);
        }
    }
    const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
    return { status: r.status, corpo: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() };
}

before(async () => {
    servidor = spawn('node', ['server.mjs'], {
        cwd: RAIZ, env: { ...process.env, PORT: String(PORTA) }, stdio: ['ignore', 'pipe', 'pipe']
    });
    for (let i = 0; i < 60; i++) {
        try {
            await fetch(BASE, { signal: AbortSignal.timeout(500) });
            break;
        } catch {
            await new Promise(s => setTimeout(s, 250));
        }
    }
    // Descobre um alvo real em vez de fixar um nome de repo: o teste tem que valer em qualquer workspace.
    const { corpo } = await pegar('/api/chamados');
    const c = (corpo.lista || [])[0];
    if (c) {
        const r = c.repos[0];
        contexto = { chamado: c.chamado, projeto: r.projeto, ref: r.ref || '' };
    }
});

after(() => servidor?.kill());

test('a casca HTML sobe e referencia o app', async () => {
    const { status, corpo } = await pegar('/');
    assert.equal(status, 200);
    assert.match(corpo, /<title>/);
    assert.match(corpo, /src="\/app\.js"/);
    assert.match(corpo, /window\.ESQUELETO = \[/);
});

test('os estáticos são servidos e o caminho não escapa da pasta web', async () => {
    for (const arquivo of ['/estilo.css', '/app.js', '/realce.js']) {
        const { status, corpo } = await pegar(arquivo);
        assert.equal(status, 200, arquivo);
        assert.ok(corpo.length > 100, arquivo);
    }
    const fuga = await pegar('/../package.json');
    assert.notEqual(fuga.status, 200);
});

test('/api/chamados devolve lista com a forma esperada', async () => {
    const { status, corpo } = await pegar('/api/chamados');
    assert.equal(status, 200);
    assert.ok(Array.isArray(corpo.lista));
    for (const c of corpo.lista) {
        assert.match(c.chamado, /^[A-Z]{2,5}-\d+$/);
        assert.ok(c.repos.length > 0);
        for (const r of c.repos) {
            assert.equal(typeof r.projeto, 'string');
            assert.equal(typeof r.naBranch, 'boolean');
        }
        // O filtro que existe para não trazer 200 chamados de branch antiga.
        assert.ok(c.repos.some(r => r.naBranch), `${c.chamado} entrou sem nenhum repo em checkout`);
    }
});

test('o esqueleto de cartões cobre todos os grupos que a tela desenha', async () => {
    const { corpo } = await pegar('/');
    const esqueleto = JSON.parse(corpo.match(/window\.ESQUELETO = (\[.*?\]);/s)[1]);
    const app = (await pegar('/app.js')).corpo;
    const grupos = [...app.matchAll(/\{ id:'([a-z]+)', rotulo:/g)].map(m => m[1]);
    assert.ok(grupos.length > 0, 'não achei os grupos de aba no app.js');
    for (const item of esqueleto) {
        assert.ok(grupos.includes(item.grupo),
            `o item '${item.id}' está no grupo '${item.grupo}', que não é uma aba`);
    }
});

test('/api/arquivos e /api/arquivo devolvem diff coerente', async t => {
    if (!contexto.projeto) {
        return t.skip('nenhum chamado aberto no workspace — rotas de diff não exercitadas');
    }
    const { status, corpo } = await pegar('/api/arquivos', { projeto: contexto.projeto, ref: contexto.ref });
    assert.equal(status, 200);
    assert.equal(typeof corpo.base, 'string');
    assert.ok(Array.isArray(corpo.arquivos));
    for (const a of corpo.arquivos) {
        assert.equal(typeof a.caminho, 'string');
        assert.equal(typeof a.adicionadas, 'number');
        assert.equal(typeof a.removidas, 'number');
    }
    if (!corpo.arquivos.length) {
        return t.skip(`${contexto.projeto} sem alterações contra a base`);
    }
    const alvo = corpo.arquivos[0].caminho;
    const um = await pegar('/api/arquivo', {
        projeto: contexto.projeto, ref: contexto.ref, base: corpo.base, caminho: alvo
    });
    assert.equal(um.status, 200);
    // As colunas têm que estar alinhadas: é o que faz o painel lado a lado não desalinhar.
    assert.equal(um.corpo.antes.length, um.corpo.depois.length, 'colunas antes/depois com tamanhos diferentes');
    // `total` mede o arquivo no disco; `antes.length` conta LINHAS RENDERIZADAS, que incluem lacuna e
    // linha de alinhamento. A invariante certa é sobre as linhas reais do lado depois.
    const reaisDepois = um.corpo.depois.filter(l => l.n !== null).length;
    assert.ok(reaisDepois <= um.corpo.total,
        `linhas reais do depois (${reaisDepois}) maior que o total do arquivo (${um.corpo.total})`);
    assert.ok(um.corpo.total >= 0, `total negativo: ${um.corpo.total}`);
});

test('a dobra reduz o payload e o modo completo traz tudo', async t => {
    if (!contexto.projeto) {
        return t.skip('nenhum chamado aberto');
    }
    const lista = (await pegar('/api/arquivos', { projeto: contexto.projeto, ref: contexto.ref })).corpo;
    const grande = (lista.arquivos || [])
        .map(a => a.caminho)
        .find(c => /\.(json|js|mjs)$/.test(c));
    if (!grande) {
        return t.skip('nenhum arquivo js/json no diff');
    }
    const dobrado = (await pegar('/api/arquivo', { projeto: contexto.projeto, ref: contexto.ref, caminho: grande })).corpo;
    const inteiro = (await pegar('/api/arquivo', { projeto: contexto.projeto, ref: contexto.ref, caminho: grande, completo: 1 })).corpo;
    assert.ok(dobrado.antes.length <= inteiro.antes.length, 'dobrado maior que o completo');
    if (dobrado.dobradas > 0) {
        assert.ok(dobrado.antes.length < inteiro.antes.length, 'disse que dobrou mas não reduziu');
        assert.ok(dobrado.antes.some(l => l.tipo === 'lacuna'), 'dobrou sem marcar lacuna');
    }
});

test('/api/qualidade devolve um item por entrada do esqueleto', async t => {
    if (!contexto.projeto) {
        return t.skip('nenhum chamado aberto');
    }
    const { status, corpo } = await pegar('/api/qualidade', {
        chamado: contexto.chamado, projeto: contexto.projeto, ref: contexto.ref
    });
    assert.equal(status, 200);
    assert.ok(Array.isArray(corpo.itens) && corpo.itens.length > 0);
    const validos = new Set(['ok', 'aviso', 'atencao', 'manual', 'indisponivel']);
    for (const i of corpo.itens) {
        assert.ok(validos.has(i.status), `status inválido '${i.status}' em ${i.id}`);
        assert.equal(typeof i.titulo, 'string');
        assert.ok(Array.isArray(i.evidencia));
        assert.ok(i.grupo, `item ${i.id} sem grupo`);
    }
});

test('/api/lint diz qual linter rodou, ou que não há linter', async t => {
    if (!contexto.projeto) {
        return t.skip('nenhum chamado aberto');
    }
    const { status, corpo } = await pegar('/api/lint', { projeto: contexto.projeto, ref: contexto.ref });
    assert.equal(status, 200);
    assert.ok(Array.isArray(corpo.linters));
    assert.ok(corpo.linters.length || corpo.nota, 'nem linter nem nota: silêncio não é resposta');
    for (const a of corpo.achados || []) {
        assert.ok(['erro', 'aviso'].includes(a.severidade));
        assert.equal(typeof a.arquivo, 'string');
    }
});

test('/api/pontos filtra por chamado e projeto', async () => {
    const { status, corpo } = await pegar('/api/pontos', { chamado: 'ZZZ-9999', projeto: 'nao-existe' });
    assert.equal(status, 200);
    assert.ok(Array.isArray(corpo.pontos));
    for (const p of corpo.pontos) {
        assert.ok(!p.chamado || p.chamado === 'ZZZ-9999');
        assert.ok(!p.projeto || p.projeto === 'nao-existe');
    }
});

test('/api/configs lista as rotinas e /api/config lê uma', async () => {
    const { status, corpo } = await pegar('/api/configs');
    assert.equal(status, 200);
    assert.ok(Array.isArray(corpo.configs));
    for (const c of corpo.configs) {
        const um = await pegar('/api/config', { chave: c.chave });
        assert.equal(um.status, 200, `config ${c.chave}`);
        assert.ok(um.corpo.conteudo === undefined || typeof um.corpo.conteudo === 'string');
    }
    // Allowlist por chave: caminho vindo do cliente não pode ser aceito.
    const fuga = await pegar('/api/config', { chave: '../../etc/passwd' });
    assert.equal(fuga.status, 404);
});

test('o cache marca doCache e /api/invalidar o derruba', async t => {
    if (!contexto.projeto) {
        return t.skip('nenhum chamado aberto');
    }
    await pegar('/api/invalidar', { projeto: contexto.projeto });
    const primeira = await pegar('/api/arquivos', { projeto: contexto.projeto, ref: contexto.ref });
    assert.equal(primeira.corpo.doCache, false);
    const segunda = await pegar('/api/arquivos', { projeto: contexto.projeto, ref: contexto.ref });
    assert.equal(segunda.corpo.doCache, true);
    await pegar('/api/invalidar', { projeto: contexto.projeto });
    const terceira = await pegar('/api/arquivos', { projeto: contexto.projeto, ref: contexto.ref });
    assert.equal(terceira.corpo.doCache, false, 'invalidar não derrubou o cache');
});

test('rota inexistente devolve 404 em vez de estourar', async () => {
    const { status } = await pegar('/api/isso-nao-existe');
    assert.equal(status, 404);
});

// ---------- ferramentas de linha de comando ----------

function rodar(script, args) {
    try {
        return { codigo: 0, saida: execFileSync('node', [join(RAIZ, 'ferramentas', script), ...args], {
            cwd: RAIZ, encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe']
        }) };
    } catch (e) {
        return { codigo: e.status ?? 1, saida: `${e.stdout || ''}${e.stderr || ''}` };
    }
}

test('checar-diff --autoteste passa', () => {
    const r = rodar('checar-diff.mjs', ['--autoteste']);
    assert.equal(r.codigo, 0, r.saida);
    assert.match(r.saida, /todos os autotestes passaram/);
});

test('checar-diff --staged olha o índice, não a branch', async t => {
    if (!contexto.projeto) {
        return t.skip('nenhum chamado aberto');
    }
    const staged = rodar('checar-diff.mjs', [contexto.projeto, '--staged', '--json']);
    const branch = rodar('checar-diff.mjs', [contexto.projeto, '--json']);
    const a = JSON.parse(staged.saida);
    const b = JSON.parse(branch.saida);
    assert.equal(a.baseReal, '--staged', '--staged foi ignorado');
    assert.notEqual(b.baseReal, '--staged');
});

test('cada ferramenta responde --json parseável', () => {
    const casos = [
        ['pontos.mjs', ['listar']],
        ['log.mjs', []],
        ['contexto.mjs', [contexto.chamado || 'ZZZ-9999']]
    ];
    for (const [script, args] of casos) {
        const r = rodar(script, [...args, '--json']);
        assert.equal(r.codigo, 0, `${script}: ${r.saida.slice(0, 200)}`);
        assert.doesNotThrow(() => JSON.parse(r.saida), `${script} não devolveu JSON: ${r.saida.slice(0, 200)}`);
    }
});

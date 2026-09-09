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
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { Diff } from '../lib/diff.mjs';
import { Comparacao } from '../lib/comparacao.mjs';
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
    // Host e token FIXOS aqui: agora que o servidor lê o `.env`, um `QUALIDADE_HOST=0.0.0.0` lá
    // faria a suíte subir exposta — e com token sorteado, o que dá 401 em tudo. O teste não pode
    // depender do que está no .env de quem roda.
    servidor = spawn('node', ['server.mjs'], {
        cwd: RAIZ,
        env: { ...process.env, PORT: String(PORTA), QUALIDADE_HOST: '127.0.0.1', QUALIDADE_TOKEN: '' },
        stdio: ['ignore', 'pipe', 'pipe']
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
    // Precisa de um repo com diff DE VERDADE: pegar o primeiro fazia as rotas de diff virarem skip
    // quando ele estava mesclado — a suíte ficava verde sem exercitar nada.
    const { corpo } = await pegar('/api/chamados');
    // Com o `chamado`: sem ele a comparação decidida não vale e a busca via 0 arquivo em tudo — 6
    // casos viravam skip e as rotas de diff deixavam de ser exercitadas.
    for (const c of corpo.lista || []) {
        for (const r of c.repos) {
            const d = (await pegar('/api/arquivos',
                { projeto: r.projeto, ref: r.ref || '', chamado: c.chamado })).corpo;
            if ((d.arquivos || []).length) {
                contexto = { chamado: c.chamado, projeto: r.projeto, ref: r.ref || '' };
                break;
            }
        }
        if (contexto.projeto) {
            break;
        }
    }
});

after(() => servidor?.kill());

test('a casca HTML sobe e referencia o app', async () => {
    const { status, corpo } = await pegar('/');
    assert.equal(status, 200);
    assert.match(corpo, /<title>/);
    assert.match(corpo, /src="\/app\.js\?v=\d+"/);
    assert.match(corpo, /window\.ESQUELETO = \[/);
    // A versão não é enfeite: é ela que faz a aba aberta descobrir, pelo SSE, que o JS dela é velho.
    // Uma aba antiga rodando código velho custou uma hora de "a tela está errada".
    assert.match(corpo, /window\.VERSAO = '\d+'/);
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

// Grupo fora do ORDEM não dá erro: cai no fim da lista em silêncio. É o que este teste pega.
test('o esqueleto de cartões cobre todos os grupos que a tela desenha', async () => {
    const { corpo } = await pegar('/');
    const esqueleto = JSON.parse(corpo.match(/window\.ESQUELETO = (\[.*?\]);/s)[1]);
    const app = (await pegar('/app.js')).corpo;
    const bloco = app.match(/const ORDEM = \[([^\]]+)\]/);
    assert.ok(bloco, 'não achei o ORDEM dos grupos no app.js');
    const grupos = [...bloco[1].matchAll(/'([a-z]+)'/g)].map(m => m[1]);
    assert.ok(grupos.length > 0, 'o ORDEM está vazio');
    for (const item of esqueleto) {
        assert.ok(grupos.includes(item.grupo),
            `o item '${item.id}' está no grupo '${item.grupo}', que não está no ORDEM`);
    }
});

// Rótulo sem tradução sai como `undefined` no cartão — sem erro nenhum no console.
test('todo status que a análise emite tem rótulo na tela', async () => {
    const app = (await pegar('/app.js')).corpo;
    const rotulos = new Set([...app.matchAll(/(\w+):'[^']+'/g)].map(m => m[1]));
    const q = readFileSync(new URL('../lib/qualidade.mjs', import.meta.url), 'utf8');
    const emitidos = new Set([...q.matchAll(/_item\('[^']+', '[^']+', '([a-z]+)'/g)].map(m => m[1])
        .concat([...q.matchAll(/status: '([a-z]+)'/g)].map(m => m[1])));
    for (const st of emitidos) {
        assert.ok(rotulos.has(st), `a análise emite '${st}' e o ROTULO da tela não tem esse status`);
    }
});

test('/api/arquivos e /api/arquivo devolvem diff coerente', async t => {
    if (!contexto.projeto) {
        return t.skip('nenhum chamado aberto no workspace — rotas de diff não exercitadas');
    }
    const { status, corpo } = await pegar('/api/arquivos', { projeto: contexto.projeto, ref: contexto.ref, chamado: contexto.chamado });
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
        projeto: contexto.projeto, ref: contexto.ref, chamado: contexto.chamado, base: corpo.base, caminho: alvo
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
    const lista = (await pegar('/api/arquivos', { projeto: contexto.projeto, ref: contexto.ref, chamado: contexto.chamado })).corpo;
    const grande = (lista.arquivos || [])
        .map(a => a.caminho)
        .find(c => /\.(json|js|mjs)$/.test(c));
    if (!grande) {
        return t.skip('nenhum arquivo js/json no diff');
    }
    const dobrado = (await pegar('/api/arquivo', { projeto: contexto.projeto, ref: contexto.ref, chamado: contexto.chamado, caminho: grande })).corpo;
    const inteiro = (await pegar('/api/arquivo', { projeto: contexto.projeto, ref: contexto.ref, chamado: contexto.chamado, caminho: grande, completo: 1 })).corpo;
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
    const validos = new Set(['ok', 'aviso', 'atencao', 'manual', 'ignorado', 'indisponivel']);
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
    const { status, corpo } = await pegar('/api/lint', { projeto: contexto.projeto, ref: contexto.ref, chamado: contexto.chamado });
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
    const primeira = await pegar('/api/arquivos', { projeto: contexto.projeto, ref: contexto.ref, chamado: contexto.chamado });
    assert.equal(primeira.corpo.doCache, false);
    const segunda = await pegar('/api/arquivos', { projeto: contexto.projeto, ref: contexto.ref, chamado: contexto.chamado });
    assert.equal(segunda.corpo.doCache, true);
    await pegar('/api/invalidar', { projeto: contexto.projeto });
    const terceira = await pegar('/api/arquivos', { projeto: contexto.projeto, ref: contexto.ref, chamado: contexto.chamado });
    assert.equal(terceira.corpo.doCache, false, 'invalidar não derrubou o cache');
});

test('rota inexistente devolve 404 em vez de estourar', async () => {
    const { status } = await pegar('/api/isso-nao-existe');
    assert.equal(status, 404);
});

test('nenhum cartão diz "ok" sobre arquivo que não foi analisado', async t => {
    // A invariante que motivou este teste: um diff de 56 arquivos Python devolvia "nenhum achado" em
    // todos os cartões, e ausência de cobertura era lida como aprovação.
    const { corpo } = await pegar('/api/chamados');
    const alvos = (corpo.lista || []).flatMap(c => c.repos.map(r => ({ chamado: c.chamado, ...r })));
    if (!alvos.length) {
        return t.skip('nenhum chamado aberto');
    }
    const mentiras = [];
    for (const alvo of alvos) {
        const q = (await pegar('/api/qualidade', {
            chamado: alvo.chamado, projeto: alvo.projeto, ref: alvo.ref || ''
        })).corpo;
        const cobertura = (q.itens || []).find(i => i.id === 'cobertura');
        if (!cobertura) {
            mentiras.push(`${alvo.projeto}: sem cartão de cobertura`);
            continue;
        }
        // A regra afinou: o alarme é CÓDIGO sem nenhuma camada. Arquivo que ferramenta nenhuma tem
        // regra para ler (`.json`, `.md`) não é ausência de cobertura, é ausência de regra.
        const nadaAnalisado = /de código sem checagem/.test(cobertura.detalhe);
        if (!nadaAnalisado) {
            continue;
        }
        for (const i of q.itens) {
            if (i.status === 'ok' && i.id !== 'branch') {
                mentiras.push(`${alvo.projeto}: '${i.titulo}' diz ok, mas 0 arquivo foi analisado`);
            }
        }
    }
    assert.deepEqual(mentiras, [], mentiras.join('\n  '));
});

test('o cartão de cobertura declara as extensões que ficaram de fora', async t => {
    const { corpo } = await pegar('/api/chamados');
    const alvo = (corpo.lista || []).flatMap(c => c.repos.map(r => ({ chamado: c.chamado, ...r })))[0];
    if (!alvo) {
        return t.skip('nenhum chamado aberto');
    }
    const q = (await pegar('/api/qualidade', {
        chamado: alvo.chamado, projeto: alvo.projeto, ref: alvo.ref || ''
    })).corpo;
    const c = (q.itens || []).find(i => i.id === 'cobertura');
    assert.ok(c, 'cartão de cobertura ausente');
    assert.match(c.detalhe, /arquivo\(s\)|alteração/, `detalhe sem denominador: ${c.detalhe}`);
    if (/de \d+ arquivo/.test(c.detalhe) && !/^(\d+) de \1 /.test(c.detalhe)) {
        // Exige a extensão NOMEADA, não a palavra "extensão": o texto mudou para "sem regra
        // aplicável: .json" quando as três camadas entraram, e o que importa é dizer QUAIS.
        assert.ok(c.evidencia.some(e => /\.[a-z0-9]{1,10}\b/i.test(e)),
            `cobertura parcial sem nomear as extensões: ${JSON.stringify(c.evidencia)}`);
    }
});

// ---------- ferramentas de linha de comando ----------

function rodar(script, args) {
    try {
        // Sem gh: o teste é da FORMA da saída, não do estado das PRs — e bater no GitHub de 11
        // repos fazia este ser o único caso intermitente da suíte.
        return { codigo: 0, saida: execFileSync('node', [join(RAIZ, 'ferramentas', script), ...args], {
            cwd: RAIZ, encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, QUALIDADE_SEM_GH: '1' }
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

// Repo sintético: merge por squash é o caso que topologia não vê, e era 11 arquivos de diff falso
// no UND-1638. Os dois testes abaixo exigem o jeito certo (mesclado → vazio) E o errado
// (trabalho depois do merge → continua aparecendo), senão a correção viraria cegueira.
function repoDeTeste(nome) {
    const raiz = mkdtempSync(join(tmpdir(), `qualidade-${nome}-`));
    const g = (...a) => execFileSync('git', ['-C', raiz, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    g('init', '-q', '-b', 'stage');
    g('config', 'user.email', 'teste@local');
    g('config', 'user.name', 'Teste');
    writeFileSync(join(raiz, 'a.txt'), 'base\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    g('update-ref', 'refs/remotes/origin/stage', 'stage');
    return { raiz, g };
}

test('merge por squash conta como mesclado, mesmo sem ser ancestral', () => {
    const { raiz, g } = repoDeTeste('squash');
    g('checkout', '-q', '-b', 'UND-1', 'stage');
    writeFileSync(join(raiz, 'a.txt'), 'base\nda branch\n');
    g('commit', '-qam', 'trabalho');
    // squash: o mesmo conteúdo entra em stage como UM commit novo, sem o commit da branch como pai
    g('checkout', '-q', 'stage');
    g('merge', '-q', '--squash', 'UND-1');
    g('commit', '-qm', 'squash de UND-1');
    g('update-ref', 'refs/remotes/origin/stage', 'stage');

    const d = new Diff(raiz, 'UND-1');
    const base = d.resolverBase();
    // sanidade: se isto passasse a ser ancestral, o teste deixaria de testar squash
    assert.throws(() => d.git('merge-base', '--is-ancestor', 'UND-1', 'origin/stage'));
    assert.equal(d.mesclado, true, 'squash tem que contar como mesclado');
    assert.equal(d.comoSoube, 'conteudo', 'a topologia não pode ser a fonte aqui');
    assert.equal(d.listarArquivos(base).length, 0, 'nada a revisar num squash já mesclado');
    rmSync(raiz, { recursive: true, force: true });
});

test('o filtro de pendência não esconde trabalho depois do merge', () => {
    const { raiz, g } = repoDeTeste('depois');
    g('checkout', '-q', '-b', 'UND-1', 'stage');
    writeFileSync(join(raiz, 'a.txt'), 'base\nda branch\n');
    g('commit', '-qam', 'trabalho');
    g('checkout', '-q', 'stage');
    g('merge', '-q', '--squash', 'UND-1');
    g('commit', '-qm', 'squash de UND-1');
    g('update-ref', 'refs/remotes/origin/stage', 'stage');
    // e agora um commit NOVO na branch, depois do merge: é trabalho aberto e tem que aparecer
    g('checkout', '-q', 'UND-1');
    writeFileSync(join(raiz, 'b.txt'), 'depois do merge\n');
    g('add', '-A');
    g('commit', '-qm', 'depois do merge');

    const d = new Diff(raiz, 'UND-1');
    const arquivos = d.listarArquivos(d.resolverBase()).map(a => a.caminho);
    assert.equal(d.mesclado, false, 'com trabalho pendente não é mesclado');
    assert.deepEqual(arquivos, ['b.txt'], 'só o que ainda não está no destino');
    rmSync(raiz, { recursive: true, force: true });
});

// O caso que a comparação por `git diff` errava: o destino andou por cima do MESMO arquivo depois do
// squash. O conteúdo passa a diferir nos dois sentidos, e a branch aparecia como pendente sem ter
// nada pendente. Medido no UND-1638: 2 arquivos já mesclados marcados como abertos.
//
// As duas edições ficam em regiões distintas do arquivo, que é a forma real do caso. Edição
// ADJACENTE conflita mesmo — é limite do merge de três vias, não defeito da checagem.
test('destino que andou por cima não transforma branch mesclada em pendente', () => {
    const { raiz, g } = repoDeTeste('adiante');
    const linhas = n => Array.from({ length: 20 }, (_, i) => i === n ? `linha ${i} mexida` : `linha ${i}`);
    writeFileSync(join(raiz, 'a.txt'), Array.from({ length: 20 }, (_, i) => `linha ${i}`).join('\n') + '\n');
    g('commit', '-qam', 'arquivo com 20 linhas');
    g('update-ref', 'refs/remotes/origin/stage', 'stage');

    g('checkout', '-q', '-b', 'UND-1', 'stage');
    writeFileSync(join(raiz, 'a.txt'), linhas(4).join('\n') + '\n');
    g('commit', '-qam', 'trabalho na linha 4');
    g('checkout', '-q', 'stage');
    g('merge', '-q', '--squash', 'UND-1');
    g('commit', '-qm', 'squash de UND-1');
    // e agora um terceiro mexe no mesmo arquivo, em outra região, só em stage
    const comAmbas = linhas(4);
    comAmbas[17] = 'linha 17 de outra pessoa';
    writeFileSync(join(raiz, 'a.txt'), comAmbas.join('\n') + '\n');
    g('commit', '-qam', 'trabalho de terceiro');
    g('update-ref', 'refs/remotes/origin/stage', 'stage');

    const d = new Diff(raiz, 'UND-1');
    const arquivos = d.listarArquivos(d.resolverBase());
    assert.equal(d.mesclado, true, 'mesclar a branch não acrescentaria nada — está mesclada');
    assert.deepEqual(arquivos, [], 'o que o destino ganhou depois não é pendência da branch');
    rmSync(raiz, { recursive: true, force: true });
});

// Linter que não roda devolvia lista vazia, e lista vazia lê como aprovação. Piorou quando a
// Cobertura passou a CREDITAR o linter: duas mentiras empilhadas. Os dois caminhos são exigidos aqui.
test('linter que não roda é declarado, não vira aprovação', async () => {
    const { Lint } = await import('../lib/lint.mjs');
    const l = new Lint();
    const raiz = join(dirname(dirname(fileURLToPath(import.meta.url))), '..', 'integrations-core-rivio-one');
    const bin = join(raiz, '.venv/bin/ruff');
    if (!existsSync(bin)) {
        return;
    }
    const bom = await l._ruff(raiz, bin, ['app/temporal/ingress.py']);
    assert.ok(Array.isArray(bom), 'ruff que roda tem que devolver lista de achados');

    const ruim = await l._ruff(raiz, `${bin}-inexistente`, ['app/temporal/ingress.py']);
    assert.ok(!Array.isArray(ruim), 'ruff que não roda NÃO pode devolver lista vazia');
    assert.match(ruim.falha, /ENOENT|não era JSON/, 'a falha tem que dizer o motivo');
});

// Config de eslint sem `npm install` não cobre nada — creditar essa camada seria inventar cobertura.
test('eslint só conta como camada se der para rodar', async () => {
    const { Lint } = await import('../lib/lint.mjs');
    const nomes = new Lint().detectar('crohc-server').map(l => l.nome);
    assert.ok(nomes.includes('eslint'), 'crohc-server tem config e node_modules: deveria contar');
    const semInstall = new Lint().detectar('projeto-que-nao-existe').map(l => l.nome);
    assert.deepEqual(semInstall, [], 'repo inexistente não pode declarar linter');
});

// A regra que fechou a discordância entre a tela e o GitHub. Automatizar não deu: num repo real
// havia 7 PRs do mesmo chamado em 7 branches, seis mescladas e a aberta sendo outra. Então quem
// decide é o agente, e o que se testa aqui é a obediência — e o AVISO quando ninguém decidiu.
test('a tela obedece a decisão do agente, e declara quando não há decisão', () => {
    const { raiz, g } = repoDeTeste('decisao');
    g('checkout', '-q', '-b', 'UND-1', 'stage');
    writeFileSync(join(raiz, 'a.txt'), 'base\nda branch\n');
    g('commit', '-qam', 'trabalho');
    const forkPoint = g('rev-parse', 'stage').trim();
    const head = g('rev-parse', 'UND-1').trim();
    // mesclada: daqui em diante a topologia diz "nada a revisar", que é o palpite antigo
    g('checkout', '-q', 'stage');
    g('merge', '-q', '--no-ff', '-m', 'merge de UND-1', 'UND-1');
    g('update-ref', 'refs/remotes/origin/stage', 'stage');

    const tmp = join(mkdtempSync(join(tmpdir(), 'qualidade-dec-')), 'comparacoes.json');
    const c = new Comparacao(tmp);
    const semDecisao = c.resolver(raiz, 'UND-1', null, 'UND-1');
    assert.equal(semDecisao.via, 'local', 'sem decisão, a via tem que se declarar local');
    assert.equal(semDecisao.diff.listarArquivos(semDecisao.base).length, 0);

    c.definir('UND-1', raiz, {
        via: 'pr', pr: 7, base: forkPoint, head, destino: 'stage', situacao: 'aberto'
    });
    const daPr = c.resolver(raiz, 'UND-1', null, 'UND-1');
    assert.equal(daPr.via, 'pr');
    assert.equal(daPr.diff.baseNome, 'PR #7 → stage');
    assert.equal(daPr.diff.mesclado, false, 'situacao=aberto não pode virar mesclado');
    assert.deepEqual(daPr.diff.listarArquivos(daPr.base).map(a => a.caminho), ['a.txt'],
        'com decisão, aparece o que a PR mostra');

    // e a situação é veredito do agente, não recálculo da ferramenta
    c.definir('UND-1', raiz, { via: 'stage', branch: 'UND-1', base: 'origin/stage', situacao: 'resolvido' });
    const contraStage = c.resolver(raiz, 'UND-1', null, 'UND-1');
    assert.equal(contraStage.via, 'stage');
    assert.equal(contraStage.diff.mesclado, true);
    rmSync(raiz, { recursive: true, force: true });
});

// `appendFileSync` ficou meses usado e não importado: `registrar` lançava, o catch engolia, e as
// linhas DEPOIS dela no mesmo bloco nunca rodavam — foi assim que o fim da corrida do agente não
// invalidava o cache nem avisava a tela. O log é a prova de que a função inteira rodou.
test('registrar de fato escreve no gate.log', async () => {
    const log = join(dirname(dirname(fileURLToPath(import.meta.url))), 'gate.log');
    const antes = existsSync(log) ? readFileSync(log, 'utf8').length : 0;
    // `ponto-remover` de um id inexistente loga e não muda nada — as outras rotas que logam têm
    // efeito colateral (ocultar/mostrar chamado), e teste não pode mexer no que o usuário vê.
    await pegar('/api/ponto-remover', { id: 'id-que-nao-existe-de-proposito' });
    const depois = readFileSync(log, 'utf8');
    assert.ok(depois.length > antes, 'a rota logou nada — registrar está engolindo erro');
    assert.match(depois.trimEnd().split('\n').pop(), /\tponto-remover\tnao-encontrado\t/);
});

// Expor na rede sem senha deixaria `/api/agente` — que spawna `claude -p` com Bash — aberto para
// quem estiver na LAN. O teste exige as duas metades: token errado é 401 em TODA rota, e o token
// certo passa. Sobe um servidor próprio porque o do `before` é local e sem token.
// Token protege o ACESSO; isto protege a CAPACIDADE. A corrida spawna `claude -p` com Bash na
// máquina do servidor, então pela LAN ela não deve nem estar disponível — token vazado, máquina
// emprestada ou aba esquecida não podem virar execução de comando.
test('pela rede, a corrida do agente é negada mesmo com o token certo', async () => {
    const porta = PORTA + 4;
    const token = 'token-de-teste-lan';
    const ip = Object.values(networkInterfaces()).flat()
        .find(i => i && i.family === 'IPv4' && !i.internal)?.address;
    const filho = spawn('node', ['server.mjs'], {
        cwd: RAIZ, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(porta), QUALIDADE_HOST: '0.0.0.0', QUALIDADE_TOKEN: token }
    });
    try {
        for (let i = 0; i < 60; i++) {
            try {
                await fetch(`http://127.0.0.1:${porta}/?t=${token}`, { signal: AbortSignal.timeout(500) });
                break;
            } catch {
                await new Promise(s => setTimeout(s, 250));
            }
        }
        if (!ip) {
            return;   // máquina sem interface de rede: nada a exercitar
        }
        const pelaLan = await (await fetch(`http://${ip}:${porta}/api/agente?chamado=UND-1&t=${token}`)).json();
        assert.equal(pelaLan.ok, false, 'a corrida NÃO pode ser aceita pela rede');
        assert.match(pelaLan.erro, /só roda na máquina/);
        const html = await (await fetch(`http://${ip}:${porta}/?t=${token}`)).text();
        assert.match(html, /window\.LOCAL = false/, 'a página tem que dizer ao cliente que ele não é local');
    } finally {
        filho.kill();
    }
});

test('exposto na rede, nada responde sem o token', async () => {
    const porta = PORTA + 3;
    const token = 'token-de-teste-abcdef';
    // Pelo IP da rede, não por 127.0.0.1: o localhost é isento de token por decisão, e é
    // justamente essa isenção que este caso NÃO pode exercitar.
    const ip = Object.values(networkInterfaces()).flat()
        .find(i => i && i.family === 'IPv4' && !i.internal)?.address;
    const filho = spawn('node', ['server.mjs'], {
        cwd: RAIZ, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(porta), QUALIDADE_HOST: '0.0.0.0', QUALIDADE_TOKEN: token }
    });
    try {
        for (let i = 0; i < 60; i++) {
            try {
                await fetch(`http://127.0.0.1:${porta}/`, { signal: AbortSignal.timeout(500) });
                break;
            } catch {
                await new Promise(s => setTimeout(s, 250));
            }
        }
        if (!ip) {
            return;   // máquina sem interface de rede: nada a exercitar
        }
        const base = `http://${ip}:${porta}`;
        for (const rota of ['/', '/api/chamados', '/api/agente?chamado=UND-1', '/api/config-salvar']) {
            const sem = await fetch(`${base}${rota}`);
            assert.equal(sem.status, 401, `${rota} respondeu sem token`);
            const errado = await fetch(`${base}${rota}${rota.includes('?') ? '&' : '?'}t=nao-e-o-token`);
            assert.equal(errado.status, 401, `${rota} aceitou token errado`);
        }
        const ok = await fetch(`${base}/?t=${token}`);
        assert.equal(ok.status, 200, 'o token certo tem que passar');
        assert.match(await ok.text(), new RegExp(`window.TOKEN = '${token}'`), 'a página tem que levar o token');
        // Do localhost, sem token nenhum, e reconhecido como local — é o que libera a corrida.
        const local = await fetch(`http://127.0.0.1:${porta}/`);
        assert.equal(local.status, 200, 'localhost não pode exigir token');
        assert.match(await local.text(), /window\.LOCAL = true/, 'localhost tem que ser reconhecido como local');
    } finally {
        filho.kill();
    }
});

// Os assets da própria tela ficam fora do token: a URL deles vem do HTML sem `?t=`, e exigir token
// ali dava 401 no app.js — o app nunca iniciava e a tela ficava carregando para sempre pela LAN.
// O que NÃO pode vazar continua exigindo: `/` e todo `/api/`.
test('com token, os assets abrem e o resto não', async () => {
    const porta = PORTA + 5;
    const token = 'token-de-teste-assets';
    const ip = Object.values(networkInterfaces()).flat()
        .find(i => i && i.family === 'IPv4' && !i.internal)?.address;
    const filho = spawn('node', ['server.mjs'], {
        cwd: RAIZ, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(porta), QUALIDADE_HOST: '0.0.0.0', QUALIDADE_TOKEN: token }
    });
    try {
        const base = `http://127.0.0.1:${porta}`;
        for (let i = 0; i < 60; i++) {
            try {
                await fetch(`${base}/?t=${token}`, { signal: AbortSignal.timeout(500) });
                break;
            } catch {
                await new Promise(s => setTimeout(s, 250));
            }
        }
        for (const asset of ['/app.js', '/estilo.css', '/realce.js', '/favicon.svg']) {
            assert.equal((await fetch(`${base}${asset}`)).status, 200, `${asset} precisa abrir sem token`);
        }
        // Do localhost tudo abre (isento); de fora, casca e API exigem token.
        assert.equal((await fetch(`${base}/`)).status, 200, 'do localhost a casca abre sem token');
        if (ip) {
            assert.equal((await fetch(`http://${ip}:${porta}/`)).status, 401, 'de fora, a casca exige token');
            assert.equal((await fetch(`http://${ip}:${porta}/api/chamados`)).status, 401, 'de fora, a API exige token');
        }
    } finally {
        filho.kill();
    }
});

// O "bug dos PRs que se resolve saindo e voltando": `/api/prs` bate no `gh` e leva segundos, e
// trocar de chamado antes da resposta fazia a lista do ANTERIOR cair na trilha do atual. A guarda é
// uma geração por chamado — este teste exige que ela exista e seja usada no retorno do fetch.
test('o fetch de PRs tem guarda de geração por chamado', async () => {
    const app = (await pegar('/app.js')).corpo;
    assert.match(app, /let geracaoChamado = 0;/, 'sem contador de geração do chamado');
    const bloco = app.match(/const tokenChamado = \+\+geracaoChamado;[\s\S]{0,400}/);
    assert.ok(bloco, 'o fetch de PRs não abre uma geração');
    assert.match(bloco[0], /api\('\/api\/prs'/, 'a geração tem que ser aberta junto do fetch de PRs');
    assert.match(bloco[0], /if \(tokenChamado !== geracaoChamado\) \{ return; \}/,
        'o retorno do fetch não compara a geração — resposta velha ainda pinta a tela');
});

// Serve-velho-e-revalida: expirado deixou de ser motivo para ESPERAR. O teste exige as duas metades
// — a resposta expirada vem marcada `revalidando` e do cache, e a revalidação escreve um valor novo
// sem que ninguém tenha esperado por ela.
test('cache expirado serve o velho e revalida atrás', async () => {
    // TTL de 30 s é o do `chamados`, o único curto o bastante para o teste não ficar eterno.
    const primeira = (await pegar('/api/chamados')).corpo;
    assert.ok(Array.isArray(primeira.lista), 'primeira leitura tem que trazer a lista');
    const segunda = (await pegar('/api/chamados')).corpo;
    assert.equal(segunda.doCache, true, 'a segunda leitura tem que vir do cache');
    assert.ok(!segunda.revalidando, 'dentro do TTL não há o que revalidar');

    await new Promise(s => setTimeout(s, 31000));
    const t = Date.now();
    const expirada = (await pegar('/api/chamados')).corpo;
    const levou = Date.now() - t;
    assert.equal(expirada.doCache, true, 'expirada TAMBÉM vem do cache — é o ponto');
    assert.equal(expirada.revalidando, true, 'expirada tem que se declarar em revalidação');
    assert.ok(levou < 1500, `serviu em ${levou} ms: expirado não pode esperar a varredura`);
    assert.equal(expirada.desde, segunda.desde, 'o dado servido tem que ser o mesmo de antes');
});

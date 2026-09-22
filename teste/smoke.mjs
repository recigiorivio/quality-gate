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
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { Diff, CatFile, WORKSPACE } from '../lib/diff.mjs';
import { Comparacao } from '../lib/comparacao.mjs';
import { Implantacao } from '../lib/implantacao.mjs';
import { Sessoes } from '../lib/sessoes.mjs';
import { Builds } from '../lib/builds.mjs';
import { repos as catalogoDoBanco } from '../lib/db.mjs';
import { recusarEstadoDeProducao } from './anteparo.mjs';
import { ler, gravar, mesclar } from '../lib/estado.mjs';
import { caminhoEstado, fechar } from '../lib/db.mjs';
import { Workspace } from '../lib/workspace.mjs';
import { mdParaHtml } from '../web/markdown.js';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));

recusarEstadoDeProducao();

// Porta fixa e distinta da do app (4100): porta sorteada tornava impossível saber, olhando o
// terminal, se o que subiu era o servidor de verdade ou o do teste.
const PORTA = Number(process.env.PORTA_TESTE || 4199);
const BASE = `http://127.0.0.1:${PORTA}`;

let servidor;
let contexto = { chamado: null, projeto: null, ref: '', caminho: null };

// `after` só roda se a suíte terminar normalmente. Abortada por Ctrl-C, timeout do runner ou kill,
// ela deixava `node server.mjs` de pé na porta de teste, e a rodada seguinte media o servidor velho.
const servidores = new Set();

function encerrarServidores() {
    for (const filho of servidores) {
        try {
            filho.kill('SIGKILL');
        } catch {
            // já morreu, que é justamente o objetivo
        }
    }
    servidores.clear();
}

process.on('exit', encerrarServidores);
for (const sinal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sinal, () => {
        encerrarServidores();
        process.exit(1);
    });
}

// Sobe um servidor e espera ele responder. O registro é o que faz o encerramento valer para os
// QUATRO servidores da suíte, e não só para o do `before`.
async function subirServidor({ porta, host = '127.0.0.1', token = '' }) {
    const filho = spawn('node', ['server.mjs'], {
        cwd: RAIZ,
        env: { ...process.env, PORT: String(porta), QUALIDADE_HOST: host, QUALIDADE_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    servidores.add(filho);
    filho.on('exit', () => servidores.delete(filho));
    // Pipe que ninguém lê enche em 64 KB e BLOQUEIA o servidor no meio da suíte — e a falha aparece
    // em testes aleatórios lá na frente. Consumir sempre; a cauda fica para diagnóstico.
    filho.cauda = '';
    for (const fluxo of [filho.stdout, filho.stderr]) {
        fluxo.setEncoding('utf8');
        fluxo.on('data', d => {
            filho.cauda = (filho.cauda + d).slice(-4000);
        });
    }
    const sonda = token ? `http://127.0.0.1:${porta}/?t=${token}` : `http://127.0.0.1:${porta}/`;
    for (let i = 0; i < 60; i++) {
        try {
            await fetch(sonda, { signal: AbortSignal.timeout(500) });
            return filho;
        } catch {
            await new Promise(s => setTimeout(s, 250));
        }
    }
    // Servidor que não sobe fazia a suíte inteira falhar em testes que não têm nada a ver. Estourar
    // aqui, com a cauda do processo, diz o motivo de uma vez.
    throw new Error(`o servidor de teste não subiu na porta ${porta}:\n${filho.cauda}`);
}

function derrubarServidor(filho) {
    servidores.delete(filho);
    filho.kill();
}

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

// Os alvos vêm do Workspace, não de `/api/chamados`: a rota tira os OCULTOS, que são preferência de
// exibição do usuário — chamado escondido da tela continua sendo repo com trabalho para conferir.
async function alvosDoWorkspace() {
    const lista = await new Workspace().chamados();
    return lista.flatMap(c => c.repos.map(r => ({ chamado: c.chamado, ...r })));
}

before(async () => {
    // Host e token FIXOS aqui: agora que o servidor lê o `.env`, um `QUALIDADE_HOST=0.0.0.0` lá
    // faria a suíte subir exposta — e com token sorteado, o que dá 401 em tudo. O teste não pode
    // depender do que está no .env de quem roda.
    servidor = await subirServidor({ porta: PORTA });
    // Alvo com diff DE VERDADE: repo fixo não valeria em outro workspace, e pegar o primeiro fazia
    // as rotas de diff virarem skip quando ele estava mesclado — a suíte verde sem exercitar nada.
    for (const alvo of await alvosDoWorkspace()) {
        const d = (await pegar('/api/arquivos',
            { projeto: alvo.projeto, ref: alvo.ref || '', chamado: alvo.chamado })).corpo;
        if ((d.arquivos || []).length) {
            contexto = { chamado: alvo.chamado, projeto: alvo.projeto, ref: alvo.ref || '' };
            break;
        }
    }
});

after(encerrarServidores);

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
    const alvos = await alvosDoWorkspace();
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
    const alvo = (await alvosDoWorkspace())[0];
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

    // O construtor de `Comparacao` sumiu na migração para o banco: o `tmp` que ia aqui era
    // descartado, e a decisão caía no estado de produção. Isolar hoje é trocar `QUALIDADE_ESTADO` e
    // `fechar()` — é em `abrir()` que o arquivo do banco é resolvido.
    const estadoAnterior = process.env.QUALIDADE_ESTADO;
    const estadoDoCaso = mkdtempSync(join(tmpdir(), 'qualidade-dec-'));
    process.env.QUALIDADE_ESTADO = estadoDoCaso;
    fechar();
    try {
        const c = new Comparacao();
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
    } finally {
        fechar();
        if (estadoAnterior === undefined) {
            delete process.env.QUALIDADE_ESTADO;
        } else {
            process.env.QUALIDADE_ESTADO = estadoAnterior;
        }
        // O diretório do caso também sai: só a variável de ambiente apontava para ele, e a próxima
        // atribuição o deixava órfão. Eram 242 pastas e 5,1 MB acumulados, uma por rodada.
        rmSync(estadoDoCaso, { recursive: true, force: true });
        rmSync(raiz, { recursive: true, force: true });
    }
});

// `appendFileSync` ficou meses usado e não importado: `registrar` lançava, o catch engolia, e as
// linhas DEPOIS dela no mesmo bloco nunca rodavam — foi assim que o fim da corrida do agente não
// invalidava o cache nem avisava a tela. O log é a prova de que a função inteira rodou.
test('registrar de fato escreve no gate.log', async () => {
    const log = join(caminhoEstado(), 'gate.log');
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
test('pela rede, corrida e busca de refs são negadas mesmo com o token certo', async () => {
    const porta = PORTA + 4;
    const token = 'token-de-teste-lan';
    const ip = Object.values(networkInterfaces()).flat()
        .find(i => i && i.family === 'IPv4' && !i.internal)?.address;
    const filho = await subirServidor({ porta, host: '0.0.0.0', token });
    try {
        if (!ip) {
            return;   // máquina sem interface de rede: nada a exercitar
        }
        const pelaLan = await (await fetch(`http://${ip}:${porta}/api/agente?chamado=UND-1&t=${token}`)).json();
        assert.equal(pelaLan.ok, false, 'a corrida NÃO pode ser aceita pela rede');
        assert.match(pelaLan.erro, /só roda na máquina/);
        // `git fetch` mexe em ref dentro do `.git`: é escrita, e vale a mesma regra da corrida.
        const atualizar = await (await fetch(`http://${ip}:${porta}/api/implantacao-atualizar?t=${token}`)).json();
        assert.equal(atualizar.ok, false, 'buscar refs NÃO pode ser aceito pela rede');
        assert.match(atualizar.erro, /máquina do servidor/);
        const html = await (await fetch(`http://${ip}:${porta}/?t=${token}`)).text();
        assert.match(html, /window\.LOCAL = false/, 'a página tem que dizer ao cliente que ele não é local');
    } finally {
        derrubarServidor(filho);
    }
});

test('exposto na rede, nada responde sem o token', async () => {
    const porta = PORTA + 3;
    const token = 'token-de-teste-abcdef';
    // Pelo IP da rede, não por 127.0.0.1: o localhost é isento de token por decisão, e é
    // justamente essa isenção que este caso NÃO pode exercitar.
    const ip = Object.values(networkInterfaces()).flat()
        .find(i => i && i.family === 'IPv4' && !i.internal)?.address;
    const filho = await subirServidor({ porta, host: '0.0.0.0', token });
    try {
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
        derrubarServidor(filho);
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
    const filho = await subirServidor({ porta, host: '0.0.0.0', token });
    try {
        const base = `http://127.0.0.1:${porta}`;
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
        derrubarServidor(filho);
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

// O mesmo diretório que os módulos usam: com `QUALIDADE_ESTADO` apontando para um temporário, o
// teste que escreve no catálogo tem de escrever LÁ, senão ele mexe no arquivo de produção de novo.
const DIR_ESTADO = process.env.QUALIDADE_ESTADO || RAIZ;
const ESTADO_IMPLANTACAO = join(DIR_ESTADO, 'implantacao.json');

// A escolha de repos é estado de PRODUÇÃO, num arquivo só, no diretório do projeto. Quem mexe nele
// guarda o texto e devolve o texto — inclusive a ausência do arquivo, que também é um estado.
function leituraDoEstadoDaImplantacao() {
    return existsSync(ESTADO_IMPLANTACAO) ? readFileSync(ESTADO_IMPLANTACAO, 'utf8') : null;
}

function restaurarEstadoDaImplantacao(bruto) {
    if (bruto === null) {
        rmSync(ESTADO_IMPLANTACAO, { force: true });
        return;
    }
    writeFileSync(ESTADO_IMPLANTACAO, bruto);
}

// ── implantação: clicar num commit mostra o diff DELE ─────────────────────────
// O diff de um commit é contra o pai, e o pai vem do `git log`, não de `hash~1`: commit raiz não
// tem com quem comparar e merge tem dois. Sem o campo, a tela pediria `~1` e acertaria por sorte.
test('cada commit da implantação traz os pais', async () => {
    const impl = new Implantacao();
    const fila = await impl.resumo();
    if (!fila.length) {
        return; // workspace sem nada à frente de main: não há o que conferir
    }
    const d = await impl.detalhe(fila[0].projeto);
    assert.ok(d.listaDeCommits.length, 'detalhe sem commits');
    for (const c of d.listaDeCommits) {
        assert.ok(Array.isArray(c.pais), `${c.hash} sem a lista de pais`);
        assert.ok(c.titulo, `${c.hash} sem título — o split por \\x01 saiu de ordem`);
    }
    const merges = d.listaDeCommits.filter(c => c.pais.length > 1);
    const simples = d.listaDeCommits.filter(c => c.pais.length === 1);
    assert.ok(simples.length, 'nenhum commit com um pai só: o formato do log mudou');
    for (const m of merges) {
        assert.equal(m.pais.length, 2, `merge ${m.hash} com ${m.pais.length} pais`);
    }
});

// ── o markdown da análise ─────────────────────────────────────────────────────
// Testado de perto porque erra em SILÊNCIO: marcação que não casa vira parágrafo, e parágrafo é
// exatamente o que a pessoa esperava ver. Foi assim que a citação passou — `esc` já tinha trocado
// `>` por `&gt;` antes de a regra procurar `>`, e nenhum blockquote saía da tela.
test('o markdown da análise vira HTML', () => {
    const html = mdParaHtml([
        '## Ordem',
        '',
        '1. `migrate-mongo` primeiro',
        '2. depois **o core**',
        '',
        '> se inverter, o hash diverge',
        '',
        '- risco em UND-1991',
        '',
        '| o quê | por quê |',
        '|---|---|',
        '| `pendenciaManual` | perde o espelho |'
    ].join('\n'), id => `https://linear.app/x/issue/${id}`);

    assert.match(html, /<h4>Ordem<\/h4>/, 'título não virou h4');
    assert.match(html, /<ol>\s*<li><code>migrate-mongo<\/code> primeiro<\/li>/, 'lista numerada não saiu');
    assert.match(html, /<b>o core<\/b>/, 'negrito não saiu');
    assert.match(html, /<blockquote>se inverter, o hash diverge<\/blockquote>/,
        'citação não saiu — `esc` roda antes, então a regra tem que procurar &gt;');
    assert.match(html, /<a href="https:\/\/linear\.app\/x\/issue\/UND-1991"[^>]*>UND-1991<\/a>/,
        'o ID do chamado não virou link');
    assert.match(html, /<th>o quê<\/th>/, 'a tabela não ganhou cabeçalho');
    assert.match(html, /<td><code>pendenciaManual<\/code><\/td>/, 'a célula não saiu');
    assert.doesNotMatch(html, /\|---\|/, 'o separador da tabela vazou para o HTML');
});

test('o markdown da análise não deixa o texto virar tag', () => {
    const html = mdParaHtml('<script>alert(1)</script> e <b onclick="x">isto</b> & cia');
    // As únicas tags do resultado são as que o renderizador põe. `onclick` continua no HTML, mas
    // como TEXTO escapado — o que não pode é sobrar um `<` que o navegador leia como abertura.
    const tags = [...html.matchAll(/<\/?([a-z]+)/g)].map(m => m[1]);
    assert.deepEqual([...new Set(tags)].sort(), ['p'], `saiu tag que não é minha: ${tags}`);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'o texto tem que aparecer escapado, não sumir');
    assert.match(html, /&amp; cia/, 'o & solto tem que virar entidade');
});

// Crase é literal: `**` dentro de um comando não é negrito, e ID dentro de caminho não é link.
test('o markdown da análise respeita o que está entre crases', () => {
    const html = mdParaHtml('rode `git log --format=**%s**` no repo do UND-1638 e veja `docs/UND-1638.md`',
        id => `https://linear.app/x/issue/${id}`);
    assert.match(html, /<code>git log --format=\*\*%s\*\*<\/code>/, '`**` dentro de código virou negrito');
    assert.match(html, /<code>docs\/UND-1638\.md<\/code>/, 'o ID dentro de código virou link');
    assert.equal((html.match(/<a /g) || []).length, 1, 'só o ID fora de código podia virar link');
});

test('cerca de código aberta e não fechada não vaza', () => {
    const html = mdParaHtml('antes\n```\nnpm test\n');
    assert.equal((html.match(/<pre/g) || []).length, 1);
    assert.equal((html.match(/<\/code><\/pre>/g) || []).length, 1, 'o <pre> ficou aberto');
});

// Uma restauração de `estilo.css` levou junto o CSS não commitado da trilha e da sanfona: a tela
// abriu inteira, sem erro nenhum, com os números do release virando texto solto e a barra virando
// lista crua. Nenhum dos 40 testes viu — todos olhavam comportamento, e folha de estilo não tem
// comportamento. Este olha a única coisa que dá para afirmar sem abrir navegador: toda classe que o
// JS ESCREVE no HTML tem regra em algum lugar da folha.
test('toda classe que a tela escreve tem regra no CSS', () => {
    const css = readFileSync(join(RAIZ, 'web/estilo.css'), 'utf8');
    const usadas = new Set();
    for (const arquivo of ['web/app.js', 'web/pagina.mjs', 'web/markdown.js']) {
        const fonte = readFileSync(join(RAIZ, arquivo), 'utf8');
        // Só atributo literal: classe montada com ${} depende de dado e não dá para conferir aqui.
        for (const m of fonte.matchAll(/class="([^"$]*)"/g)) {
            for (const c of m[1].split(/\s+/).filter(Boolean)) {
                usadas.add(c);
            }
        }
    }
    assert.ok(usadas.size > 100, `só ${usadas.size} classes encontradas — a varredura quebrou`);
    const semRegra = [...usadas]
        .filter(c => !new RegExp(`[.\\s,>:]${c.replace(/[-]/g, '\\-')}(?![\\w-])`).test(css));
    assert.deepEqual(semRegra, [], `classes sem CSS: ${semRegra.join(', ')}`);
});

// ── o botão de recarregar os refs ─────────────────────────────────────────────
// A fila é lida de `origin/main` e `origin/stage`, que são cópias LOCAIS. Medido em 10/09/2026: a
// tela mostrava 36 commits a implantar no contas-service para uma release que já estava na main —
// `stage` em dia, `main` atrasada nos 5 repos. Dado velho com cara de novo, e nada na tela dizia.
test('a fila diz quando os refs foram buscados', async () => {
    const r = (await pegar('/api/implantacao')).corpo;
    assert.ok('buscadoEm' in r,
        'sem este campo a tela não distingue "nada mudou" de "ninguém buscou" — os dois desenham a mesma fila');
});

// Sumir em silêncio é indistinguível de "a ferramenta perdeu minha seleção". Depois do primeiro
// fetch os 5 escolhidos zeraram de uma vez, e a tela mostrou "0 de 9 repos — escolha os repos"
// com o crachá ainda dizendo 5/9.
test('repo escolhido que zerou fica na fila, marcado', async () => {
    const impl = new Implantacao();
    // O arquivo INTEIRO, em texto: devolver só `escolhidos` deixava o `buscadoEm` do teste em pé, e
    // a tela do usuário passou a anunciar refs de 01/02/2026. Estado de produção se restaura por
    // igual, não por campo.
    const guardado = impl.escolhidos();
    const bruto = leituraDoEstadoDaImplantacao();
    try {
        // Um repo que com certeza não está à frente: ele mesmo é o destino da comparação.
        const parado = impl.repos().find(p => !guardado.includes(p));
        assert.ok(parado, 'workspace sem repo de sobra para o teste');
        impl.escolher([parado]);
        const fila = await impl.resumo('origin/main', 'origin/main');
        const linha = fila.find(f => f.projeto === parado);
        assert.ok(linha, 'o escolhido saiu da fila ao zerar — é o bug');
        assert.equal(linha.commits, 0);
        assert.equal(linha.implantado, true, 'a linha precisa se declarar implantada');
        for (const f of fila) {
            assert.ok(f.commits > 0 || guardado.includes(f.projeto) || f.projeto === parado,
                `${f.projeto} tem 0 commits e não é escolhido: não devia estar na fila`);
        }
    } finally {
        restaurarEstadoDaImplantacao(bruto);
    }
});

// `git` que falha e `git log` vazio são coisas diferentes: devolver null nos dois fazia o servidor
// responder "sem origin/main ou origin/stage" — erro de configuração — para quem só tinha mesclado.
test('detalhe de repo já implantado não é erro', async () => {
    const impl = new Implantacao();
    const projeto = impl.repos()[0];
    const d = await impl.detalhe(projeto, 'origin/main', 'origin/main');
    assert.ok(d, 'zero commits virou erro em vez de resposta');
    assert.equal(d.commits, 0);
    assert.deepEqual(d.listaDeCommits, []);
    assert.equal(d.arquivos, 0);
    assert.equal(d.primeiroCommit, null);
});

// Gravar o objeto inteiro apagava o campo do outro: `escolher` e `buscarRemoto` escrevem chaves
// diferentes do mesmo JSON, e a escolha sumia a cada busca.
test('escolha e data da busca convivem no mesmo arquivo', () => {
    const impl = new Implantacao();
    const bruto = leituraDoEstadoDaImplantacao();
    try {
        impl._gravar({ buscadoEm: '2026-01-01T00:00:00.000Z' });
        impl.escolher(['um', 'dois']);
        assert.equal(impl.buscadoEm(), '2026-01-01T00:00:00.000Z', 'escolher apagou a data da busca');
        assert.deepEqual(impl.escolhidos(), ['um', 'dois']);
        impl._gravar({ buscadoEm: '2026-02-02T00:00:00.000Z' });
        assert.deepEqual(impl.escolhidos(), ['um', 'dois'], 'gravar a data apagou a escolha');
    } finally {
        restaurarEstadoDaImplantacao(bruto);
    }
});

// ── estado em JSON, escrito sem deixar rastro pela metade ─────────────────────
// Seis escritores, cada um com o seu `writeFileSync` por cima do arquivo vivo, e todo leitor com
// `catch { return {} }`: arquivo truncado por crash lia como VAZIO, e o estado da pessoa sumia sem
// erro. E `escolher` apagou o `buscadoEm` que `buscarRemoto` tinha acabado de gravar.
test('estado quebrado não lê como vazio — ele grita e guarda o original', () => {
    const pasta = mkdtempSync(join(tmpdir(), 'estado-'));
    const arquivo = join(pasta, 'coisa.json');
    try {
        assert.deepEqual(ler(arquivo, { a: 1 }), { a: 1 }, 'ausente devolve o padrão');
        writeFileSync(arquivo, '{"projetos": ["um"');   // truncado, como um crash deixaria
        assert.throws(() => ler(arquivo), /não é JSON válido/,
            'JSON quebrado tem que subir como erro; devolver {} apaga o estado por cima do defeito');
        assert.ok(existsSync(`${arquivo}.ruim`), 'o conteúdo ruim tem que ser preservado');
        assert.match(readFileSync(`${arquivo}.ruim`, 'utf8'), /^\{"projetos"/);
    } finally {
        rmSync(pasta, { recursive: true, force: true });
    }
});

test('mesclar não apaga o campo que o outro escritor gravou', () => {
    const pasta = mkdtempSync(join(tmpdir(), 'estado-'));
    const arquivo = join(pasta, 'coisa.json');
    try {
        mesclar(arquivo, { projetos: ['a', 'b'] });
        mesclar(arquivo, { buscadoEm: '2026-09-10T00:00:00.000Z' });
        const d = ler(arquivo);
        assert.deepEqual(d.projetos, ['a', 'b'], 'gravar a data apagou a escolha');
        assert.equal(d.buscadoEm, '2026-09-10T00:00:00.000Z');
    } finally {
        rmSync(pasta, { recursive: true, force: true });
    }
});

test('gravar não deixa temporário para trás', () => {
    const pasta = mkdtempSync(join(tmpdir(), 'estado-'));
    try {
        gravar(join(pasta, 'coisa.json'), { a: 1 });
        const sobrando = readdirSync(pasta).filter(n => n.includes('.tmp'));
        assert.deepEqual(sobrando, [], `temporário não removido: ${sobrando}`);
    } finally {
        rmSync(pasta, { recursive: true, force: true });
    }
});

// ── catálogo de repositórios ──────────────────────────────────────────────────
// `origin/main...origin/stage` era nome chumbado no código: quem não tivesse os dois refs sumia da
// fila em silêncio. Medido: 20 das 51 pastas caíam fora, e 5 delas tinham fluxo de deploy real.
test('a detecção acha par de branches fora do stage→main', async () => {
    const impl = new Implantacao();
    const um = await impl.catalogo.detectarUm('drmarvin-core-js');
    if (!um.origem && /git não respondeu/.test(um.motivo || '')) {
        return; // repo ausente nesta máquina
    }
    assert.equal(um.destino, 'origin/main');
    assert.equal(um.origem, 'origin/desenv', 'o par deste repo não é stage→main, e a detecção tem que ver isso');
});

// `origin/HEAD` é o padrão declarado pelo remoto, mas em 4 repos daqui ele aponta para `stage`.
// Aceitar isso fazia a branch de integração virar DESTINO, e aí não sobrava origem: o repo sumia.
test('branch de integração não vira destino, mesmo sendo a padrão do remoto', async () => {
    const impl = new Implantacao();
    const um = await impl.catalogo.detectarUm('jungle-monorepo');
    if (!um.origem && /git não respondeu/.test(um.motivo || '')) {
        return;
    }
    assert.equal(um.origem, 'origin/stage');
    assert.equal(um.destino, 'origin/main', 'origin/HEAD aponta para stage neste repo — não pode ser o destino');
});

test('edição manual sobrevive à detecção; linha detectada é recalculada', async () => {
    const impl = new Implantacao();
    const bruto = existsSync(join(DIR_ESTADO, 'repos.json'))
        ? readFileSync(join(DIR_ESTADO, 'repos.json'), 'utf8') : null;
    try {
        if (!impl.catalogo.listar().length) {
            await impl.catalogo.detectar();
        }
        const antes = impl.catalogo.listar();
        const alvo = antes.find(r => r.ativo)?.projeto;
        assert.ok(alvo, 'catálogo sem repo ativo para o teste');
        impl.catalogo.substituirTudo(antes.map(r => (r.projeto === alvo
            ? { ...r, origem: 'origin/inventada', destino: 'origin/tambem-inventada' } : r)));
        assert.equal(impl.catalogo.listar().find(r => r.projeto === alvo).fonte, 'manual',
            'mexer na linha tem que marcá-la como manual');
        await impl.catalogo.detectar();
        const depois = impl.catalogo.listar().find(r => r.projeto === alvo);
        assert.equal(depois.origem, 'origin/inventada', 'a detecção passou por cima da edição manual');
        assert.equal(depois.fonte, 'manual');
    } finally {
        if (bruto === null) {
            rmSync(join(DIR_ESTADO, 'repos.json'), { force: true });
        } else {
            writeFileSync(join(DIR_ESTADO, 'repos.json'), bruto);
        }
    }
});

// Desligar é decisão de gente e tem que colar; mas o `ativo:false` de uma detecção que FALHOU não
// pode virar decisão — foi o que manteve 4 repos fora depois de eu corrigir a detecção deles.
// Dois invariantes OPOSTOS, e por isso dois casos. Espremidos num só, a primeira metade tornava a
// linha `manual` e a segunda não conseguia mais montar o caso dela — `gravarDetectados` recusa
// tocar linha manual, que é justamente o que o primeiro caso prova. Teste que não consegue montar
// o próprio cenário é teste que passou a medir outra coisa.
test('desligar um repo vira manual e a detecção não religa', async () => {
    const impl = new Implantacao();
    let alvo = null;
    try {
        if (!impl.catalogo.listar().length) {
            await impl.catalogo.detectar();
        }
        alvo = impl.catalogo.listar().find(r => r.ativo)?.projeto;
        assert.ok(alvo, 'catálogo sem repo ativo para o teste');
        impl.catalogo.salvarUm({ ...impl.catalogo.listar().find(r => r.projeto === alvo), ativo: false });
        const desligado = impl.catalogo.listar().find(r => r.projeto === alvo);
        assert.equal(desligado.fonte, 'manual', 'desmarcar tem que contar como edição');
        assert.equal(desligado.ativo, false);
        await impl.catalogo.detectar();
        assert.equal(impl.catalogo.listar().find(r => r.projeto === alvo).ativo, false,
            'a detecção religou um repo que a pessoa desligou');
    } finally {
        // Devolve exatamente a linha que este caso marcou, e não "a primeira manual que aparecer":
        // o catálogo pode ter linha manual de verdade, e limpeza que adivinha apaga decisão alheia.
        if (alvo) {
            catalogoDoBanco.remover(alvo);
            await impl.catalogo.detectar();
        }
    }
});

// O contrário: linha DETECTADA é derivada, recalculada a cada rodada. Sem par ela desliga; quando o
// par aparece, ela religa sozinha — sem ninguém marcar nada à mão. Foi este invariante que eu errei
// duas vezes no dia em que o catálogo nasceu, honrando o `ativo:false` de uma detecção que falhara
// como se fosse decisão de gente.
test('linha detectada é derivada: sem par desliga, com par religa', async () => {
    const impl = new Implantacao();
    if (!impl.catalogo.listar().length) {
        await impl.catalogo.detectar();
    }
    const todas = impl.catalogo.listar();
    const alvo = todas.find(r => r.ativo && r.fonte === 'detectado')?.projeto;
    assert.ok(alvo, 'catálogo sem repo detectado e ativo para o teste');

    // Monta pelo caminho que de fato produz este estado: `gravarDetectados` com o par vazio é o que
    // `detectar()` grava quando não acha branch. Gravar `repos.json` aqui virou no-op no dia em que
    // o catálogo saiu do arquivo para a tabela.
    catalogoDoBanco.gravarDetectados(todas.map(r => (r.projeto === alvo
        ? { projeto: alvo, origem: null, destino: null, motivo: 'sem par nesta rodada' } : r)));
    const semPar = impl.catalogo.listar().find(r => r.projeto === alvo);
    assert.equal(semPar.fonte, 'detectado', 'a montagem não pode transformar a linha em manual');
    assert.equal(semPar.ativo, false, 'sem par, a linha derivada desliga');

    await impl.catalogo.detectar();
    assert.equal(impl.catalogo.listar().find(r => r.projeto === alvo).ativo, true,
        'com par encontrado, a linha derivada tem que religar sozinha');
});

// A rota é o caminho do botão: medido antes da correção, a aba B repunha a cópia velha e a edição
// da aba A sumia com `ok: true` — o módulo ficava verde e a tela perdia a edição.
test('/api/repos-salvar grava a linha nomeada e recusa a lista inteira sem `substituir`', async () => {
    const post = corpo => fetch(`${BASE}/api/repos-salvar`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo)
    }).then(async r => ({ status: r.status, corpo: await r.json() }));
    try {
        await post({ repo: { projeto: 'rota-alfa', origem: 'origin/stage', destino: 'origin/main', ativo: true } });
        await post({ repo: { projeto: 'rota-beta', origem: 'origin/stage', destino: 'origin/main', ativo: true } });
        const listaQueAAbaBCarregou = (await pegar('/api/repos')).corpo.repos;

        const editada = await post({ repo: { projeto: 'rota-alfa', origem: 'origin/desenv', destino: 'origin/main', ativo: true } });
        assert.equal(editada.corpo.repos.find(r => r.projeto === 'rota-alfa').origem, 'origin/desenv');

        const velha = await post({ repos: listaQueAAbaBCarregou });
        assert.equal(velha.status, 400, 'a rota aceitou a lista inteira — é o pedido que apaga a edição da outra aba');
        assert.match(velha.corpo.erro, /substituir/);
        const depois = (await pegar('/api/repos')).corpo.repos;
        assert.equal(depois.find(r => r.projeto === 'rota-alfa').origem, 'origin/desenv',
            'a edição da aba A sumiu depois do salvamento da aba B');

        const semBeta = await post({ remover: 'rota-beta' });
        assert.equal(semBeta.corpo.repos.some(r => r.projeto === 'rota-beta'), false, 'remover não tirou a linha nomeada');
        assert.equal((await post({ remover: 'rota-beta' })).corpo.ok, true, 'repetir a remoção tem que ser inócuo');

        // A substituição em massa continua existindo: a lista vai inteira, menos o repo de teste,
        // e é ele que tem que sumir. Sem `substituir` este mesmo corpo seria recusado acima.
        const massa = await post({ repos: depois.filter(r => r.projeto !== 'rota-alfa'), substituir: true });
        assert.equal(massa.corpo.repos.some(r => r.projeto === 'rota-alfa'), false,
            'com `substituir` a lista inteira tem que apagar quem não veio nela');
    } finally {
        await post({ remover: 'rota-alfa' });
        await post({ remover: 'rota-beta' });
    }
});

test('a fila compara cada repo pelo par dele', async () => {
    const impl = new Implantacao();
    if (!impl.catalogo.listar().length) {
        await impl.catalogo.detectar();
    }
    const fila = await impl.resumo();
    const pares = new Map(impl.catalogo.listar().map(r => [r.projeto, r]));
    for (const f of fila) {
        const esperado = pares.get(f.projeto);
        assert.ok(esperado, `${f.projeto} está na fila e não está no catálogo`);
        assert.equal(f.origem, esperado.origem, `${f.projeto} comparado por origem errada`);
        assert.equal(f.destino, esperado.destino, `${f.projeto} comparado por destino errado`);
    }
});

// Marcar/desmarcar mandava o CONJUNTO inteiro de escolhidos. Um clique repetido pelo navegador
// contra a lista que se redesenha apagou a escolha três vezes durante este desenvolvimento: cada
// repetição acertava a primeira linha restante e ia comendo os repos um a um. Nomear o repo torna a
// repetição inócua — e é a diferença entre um evento duplicado ser ruído e ser perda de dado.
test('marcar/desmarcar um repo é idempotente', async () => {
    const bruto = leituraDoEstadoDaImplantacao();
    try {
        const partida = (await pegar('/api/implantacao-escolher', { projetos: 'alfa,beta,gama' })).corpo;
        assert.deepEqual(partida.escolhidos, ['alfa', 'beta', 'gama']);

        let ultimo;
        for (let i = 0; i < 5; i++) {
            ultimo = (await pegar('/api/implantacao-escolher', { sai: 'alfa' })).corpo;
        }
        assert.deepEqual(ultimo.escolhidos, ['beta', 'gama'],
            'repetir o pedido tirou mais que o repo nomeado');

        for (let i = 0; i < 3; i++) {
            ultimo = (await pegar('/api/implantacao-escolher', { entra: 'alfa' })).corpo;
        }
        assert.deepEqual([...ultimo.escolhidos].sort(), ['alfa', 'beta', 'gama'],
            'repetir a entrada duplicou ou perdeu repo');

        // e o conjunto inteiro continua funcionando, para quem de fato quer substituir a lista
        const troca = (await pegar('/api/implantacao-escolher', { projetos: 'delta' })).corpo;
        assert.deepEqual(troca.escolhidos, ['delta']);
    } finally {
        restaurarEstadoDaImplantacao(bruto);
    }
});


// ── o cat-file de vida longa tem teto e expira ────────────────────────────────

// Vazamento invisível: sem teto, cada repo visitado deixava um `git cat-file --batch` parado pelo
// resto da vida do servidor, que fica dias no ar num workspace de 51 repos.
test('canais cat-file respeitam o teto e somem quando param de ser usados', async t => {
    const repos = readdirSync(WORKSPACE)
        .filter(p => existsSync(join(WORKSPACE, p, '.git')))
        .slice(0, CatFile.TETO + 4);
    if (repos.length <= CatFile.TETO) {
        return t.skip(`workspace com ${repos.length} repos: não dá para passar do teto`);
    }

    // Só os filhos DESTE processo: outros agentes rodam cat-file na mesma máquina, e o total dela
    // não diz nada. O servidor da suíte é filho, mas os cat-file dele são netos e ficam de fora.
    const contarCanais = () => {
        const saida = execFileSync('sh', ['-c',
            `pgrep -P ${process.pid} | xargs -I{} ps -o command= -p {} 2>/dev/null`
            + ' | grep -c "cat.file ..batch" || true'], { encoding: 'utf8' });
        return Number(saida.trim()) || 0;
    };
    const esperarCanais = async quantos => {
        for (let i = 0; i < 40 && contarCanais() !== quantos; i++) {
            await new Promise(r => setTimeout(r, 50));
        }
        return contarCanais();
    };

    try {
        for (const repo of repos) {
            new Diff(repo, 'HEAD')._totalDeLinhas('README.md');
        }
        assert.equal(CatFile.abertos.size, CatFile.TETO,
            `${repos.length} repos abertos deixaram ${CatFile.abertos.size} canais no mapa`);
        assert.equal(await esperarCanais(CatFile.TETO), CatFile.TETO,
            'processos cat-file vivos passaram do teto');

        // A contagem tem de bater com o `git show`, que não usa canal nenhum: teto que devolve
        // número errado depois do despejo é pior que o vazamento.
        const [primeiro] = repos;
        const pelaCasca = new Diff(primeiro, 'HEAD')._totalDeLinhas('README.md');
        const pelaVerdade = execFileSync('sh', ['-c',
            `git -C ${join(WORKSPACE, primeiro)} show HEAD:README.md | wc -l`], { encoding: 'utf8' });
        assert.equal(pelaCasca, Number(pelaVerdade.trim()),
            'canal reaberto depois do despejo devolveu conteúdo errado');

        CatFile.expirarInativos(Date.now() + CatFile.INATIVIDADE);
        assert.equal(CatFile.abertos.size, 0, 'canal inativo ficou no mapa');
        assert.equal(await esperarCanais(0), 0, 'processo cat-file sobreviveu à expiração');
        assert.equal(CatFile.faxina, null, 'faxina continuou agendada com o mapa vazio');
    } finally {
        CatFile.fecharTodos();
    }
});


// ── agentes do Claude Code abertos na máquina ────────────────────────────────
// Protegem o que a tela faz quando o registro interno da CLI falta ou o transcript é grande.

function registroFalso() {
    const raiz = mkdtempSync(join(tmpdir(), 'sessoes-'));
    const registro = join(raiz, 'sessions');
    const projetos = join(raiz, 'projects', 'proj');
    execFileSync('mkdir', ['-p', registro, projetos]);
    return { raiz, registro, projetos };
}

test('processo morto sai da lista, vivo fica', () => {
    const { registro, projetos } = registroFalso();
    // O próprio processo de teste é o "vivo" que não pode sumir da lista enquanto ele roda.
    writeFileSync(join(registro, `${process.pid}.json`), JSON.stringify({
        pid: process.pid, sessionId: 'viva', cwd: WORKSPACE, kind: 'interactive', status: 'busy'
    }));
    writeFileSync(join(registro, '2147483646.json'), JSON.stringify({
        pid: 2147483646, sessionId: 'morta', cwd: WORKSPACE, kind: 'interactive', status: 'busy'
    }));
    writeFileSync(join(registro, 'lixo.json'), '{ isto não é json');

    const r = new Sessoes(registro, projetos).resumo();
    const ids = r.sessoes.map(x => x.sessionId);
    assert.deepEqual(ids, ['viva'], 'a lista tinha que ter só a sessão viva');
    assert.equal(r.total, 1);
    assert.equal(r.ocupadas, 1);
});

// Regressão: a primeira versão lia uma janela fixa do fim e o pedido ficava fora dela numa sessão
// que trabalhou muito — a tela mostrava "—", indistinguível de "não pediu nada".
function transcriptGrande(projetos, sessionId, pedido) {
    const linhas = [JSON.stringify({ type: 'user', timestamp: '2026-09-17T10:00:00.000Z', message: { content: pedido } })];
    const recheio = 'x'.repeat(900);
    for (let i = 0; i < 700; i++) {
        linhas.push(JSON.stringify({
            type: 'assistant', timestamp: '2026-09-17T10:00:01.000Z',
            message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: recheio } }] }
        }));
    }
    const arquivo = join(projetos, `${sessionId}.jsonl`);
    writeFileSync(arquivo, linhas.join('\n'));
    return arquivo;
}

test('o pedido é achado mesmo longe do fim do transcript', () => {
    const { registro, projetos } = registroFalso();
    const arquivo = transcriptGrande(projetos, 'longa', 'arrumar o contador da barra');
    const s = new Sessoes(registro, projetos);
    assert.ok(statSync(arquivo).size > s.tetoBytes,
        'o transcript de teste precisa passar de um pedaço, senão o teste não testa nada');

    const a = s.atividade(arquivo);
    assert.equal(a.pedido, 'arrumar o contador da barra');
    assert.equal(a.truncado, false);
    // O que está acontecendo AGORA vem do fim, não do pedaço antigo onde o pedido foi achado.
    assert.equal(a.ferramenta.nome, 'Bash');
});

test('pedido fora do orçamento se declara em vez de sumir', () => {
    const { registro, projetos } = registroFalso();
    const s = new Sessoes(registro, projetos);
    const arquivo = transcriptGrande(projetos, 'curta', 'este pedido está longe demais');
    s.tetoTotal = s.tetoBytes;

    const a = s.atividade(arquivo);
    assert.equal(a.pedido, null);
    assert.equal(a.truncado, true, 'sem isto a tela mostra ausência de pedido como se não houvesse pedido');
    assert.equal(a.ferramenta.nome, 'Bash', 'o trecho lido ainda tem que dizer o que está rodando');
});

test('/api/sessoes responde resumo e detalhe com a forma esperada', async () => {
    const { status, corpo } = await pegar('/api/sessoes');
    assert.equal(status, 200);
    assert.equal(typeof corpo.total, 'number');
    assert.equal(typeof corpo.ocupadas, 'number');
    assert.ok(Array.isArray(corpo.sessoes));
    assert.equal(corpo.total, corpo.sessoes.length);
    for (const s of corpo.sessoes) {
        assert.equal(typeof s.pid, 'number');
        assert.equal(typeof s.sessionId, 'string');
        assert.equal(typeof s.daqui, 'boolean');
        assert.ok(!('pedido' in s), 'o resumo não pode pagar a leitura de transcript');
    }
    const det = await pegar('/api/sessoes', { detalhe: '1' });
    for (const s of det.corpo.sessoes) {
        assert.ok('pedido' in s && 'truncado' in s, 'o detalhe precisa dizer se o pedido foi achado');
    }
});

test('/api/builds responde a forma que o cartão da implantação lê', async () => {
    const { status, corpo } = await pegar('/api/builds');
    assert.equal(status, 200);
    assert.equal(typeof corpo.repos, 'number');
    assert.ok(Array.isArray(corpo.buildando) && Array.isArray(corpo.runs) && Array.isArray(corpo.semResposta));
    assert.equal(corpo.total, corpo.runs.length);
});

test('builds: run concluída fica fora, e o job ativo diz o passo em que está', async () => {
    const b = new Builds();
    b._slug = async () => 'org/repo';
    b._gh = async caminho => (caminho.includes('/jobs')
        ? { jobs: [{ name: 'build', status: 'in_progress',
            steps: [{ name: 'checkout', status: 'completed' }, { name: 'docker build', status: 'in_progress' }] }] }
        : { workflow_runs: [
            { id: 1, name: 'CI/CD', status: 'in_progress', head_branch: 'stage' },
            { id: 2, name: 'CI/CD', status: 'completed', conclusion: 'success' }] });
    const r = await b.detalhe(['repo']);
    assert.deepEqual(r.buildando, ['repo']);
    assert.equal(r.total, 1, 'run concluída não é build em andamento');
    assert.equal(r.runs[0].jobs[0].passo, 'docker build');
    assert.equal(r.runs[0].jobs[0].passoNumero, 2);
});

test('builds: repo sem resposta do GitHub é dito, não some', async () => {
    const b = new Builds();
    b._slug = async () => 'org/repo';
    b._gh = async () => ({ erro: 'HTTP 404' });
    const r = await b.resumo(['repo']);
    assert.equal(r.total, 0);
    assert.deepEqual(r.semResposta, [{ projeto: 'repo', erro: 'HTTP 404' }]);
});

test('builds: o slug sai de remote https, ssh e com barra no fim', () => {
    const b = new Builds();
    assert.equal(b._slugDe('https://github.com/Rivio-Tech/drmarvin-evidencia-loader/'), 'Rivio-Tech/drmarvin-evidencia-loader');
    assert.equal(b._slugDe('git@github.com:Rivio-Tech/rivio-hub.git'), 'Rivio-Tech/rivio-hub');
    assert.equal(b._slugDe('https://git.dynamix.com.br/crohc/docker/ambiente.git'), null);
});

test('builds: run concluída há menos de 5 min vai para concluidas, a mais velha fica fora', async () => {
    const b = new Builds();
    b._slug = async () => 'org/repo';
    const ha = min => new Date(Date.now() - min * 60000).toISOString();
    b._gh = async () => ({ workflow_runs: [
        { id: 1, status: 'completed', conclusion: 'failure', updated_at: ha(2) },
        { id: 2, status: 'completed', conclusion: 'success', updated_at: ha(9) }] });
    const r = await b.resumo(['repo']);
    assert.equal(r.total, 0);
    assert.deepEqual(r.concluidas.map(c => [c.id, c.conclusao]), [[1, 'failure']]);
});

test('builds: a janela vem de uma lista fechada e alarga o que conta como concluída', async () => {
    const b = new Builds();
    assert.equal(b.janela('60'), 60);
    assert.equal(b.janela('999'), 5, 'janela fora da lista cai no padrão, não vira consulta arbitrária');
    b._slug = async () => 'org/repo';
    const ha = min => new Date(Date.now() - min * 60000).toISOString();
    b._gh = async () => ({ workflow_runs: [
        { id: 1, status: 'completed', conclusion: 'success', updated_at: ha(2) },
        { id: 2, status: 'completed', conclusion: 'success', updated_at: ha(40) }] });
    assert.equal((await b.resumo(['repo'], 5)).concluidas.length, 1);
    assert.equal((await b.resumo(['repo'], 60)).concluidas.length, 2);
});

// A troca de `stage` por `develop` (19/10/2026), e por que nenhum nome de branch pode ser único.
//
// Cada caso monta repos git de verdade num workspace temporário, com os `origin/*` criados por
// `update-ref` — sem remoto e sem rede. São as situações medidas no dia: repo migrado (`develop` +
// `main`, `stage` apagada), repo que ainda não migrou (`stage` + `main`), `stage` velha convivendo
// com `develop`, e o degrau `stg` aparecendo como `origin/HEAD`.
//
// uso: npm test

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));
const WS = mkdtempSync(join(process.env.QUALIDADE_ESTADO || tmpdir(), 'ws-branches-'));
// Antes do import: `WORKSPACE` é lido uma vez, quando `lib/diff.mjs` carrega.
process.env.QUALIDADE_WORKSPACE = WS;
const { Repos } = await import('../lib/repos.mjs');
const { default: comparacao } = await import('../lib/comparacao.mjs');

after(() => rmSync(WS, { recursive: true, force: true }));

function repo(nome, branches, { cabeca, chamado } = {}) {
    const dir = join(WS, nome);
    mkdirSync(dir);
    const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.email=teste@local', '-c', 'user.name=Teste', ...a],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    g('init', '-q', '-b', branches[0]);
    writeFileSync(join(dir, 'a.txt'), 'base\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    for (const b of branches) {
        g('update-ref', `refs/remotes/origin/${b}`, 'HEAD');
    }
    if (cabeca) {
        g('symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${cabeca}`);
    }
    if (chamado) {
        g('checkout', '-q', '-b', chamado);
        writeFileSync(join(dir, 'a.txt'), 'base\nda branch\n');
        g('commit', '-qam', 'trabalho');
    }
    return dir;
}

const migrado = repo('migrado', ['develop', 'main'], { cabeca: 'develop', chamado: 'UND-1' });
const semMigrar = repo('sem-migrar', ['stage', 'main'], { chamado: 'UND-1' });
const soMain = repo('so-main', ['main'], { chamado: 'UND-1' });
repo('stage-velha', ['main', 'stage', 'develop']);
repo('com-stg', ['main', 'develop', 'stg'], { cabeca: 'stg' });

// Sem PR para observar (`QUALIDADE_SEM_GH`), a base é a queda — e a queda caía em `main` antes de
// olhar a integração: o cartão de branch mandava toda branch de chamado contra a produção.
test('a base de uma branch de chamado é a integração que existe em cada repo', () => {
    const env = { ...process.env, QUALIDADE_WORKSPACE: WS, QUALIDADE_SEM_GH: '1' };
    delete env.QUALIDADE_BASE_PADRAO;
    const saida = JSON.parse(execFileSync('node', [join(RAIZ, 'ferramentas/contexto.mjs'), 'UND-1', '--json'],
        { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }));
    const base = Object.fromEntries(saida.repos.map(r => [r.projeto, r.base?.nome]));
    assert.deepEqual(base, { migrado: 'develop', 'sem-migrar': 'stage', 'so-main': 'main' });
    assert.equal(saida.repos.find(r => r.projeto === 'migrado').commits, 1, 'o commit conta contra develop');
});

test('a detecção da Implantação prefere develop, e só cai em stage onde não migrou', async () => {
    const catalogo = new Repos();
    const par = async p => {
        const r = await catalogo.detectarUm(p);
        return `${r.origem} → ${r.destino}`;
    };
    assert.equal(await par('migrado'), 'origin/develop → origin/main', 'origin/HEAD em develop não vira destino');
    assert.equal(await par('sem-migrar'), 'origin/stage → origin/main');
    assert.equal(await par('stage-velha'), 'origin/develop → origin/main', 'stage que sobrou não ganha de develop');
});

// O degrau ainda não tem fila própria; o que não pode é ele virar o destino de produção.
test('stg como padrão do remoto não vira destino de produção', async () => {
    const r = await new Repos().detectarUm('com-stg');
    assert.equal(r.destino, 'origin/main');
    assert.equal(r.origem, 'origin/develop');
});

test('a comparação --stage sem --base usa a integração do repo, e não origin/stage fixo', () => {
    assert.equal(comparacao.integracao(migrado), 'origin/develop');
    assert.equal(comparacao.integracao(semMigrar), 'origin/stage');
    assert.equal(comparacao.integracao(soMain), 'origin/main');
});

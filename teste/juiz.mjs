// O "Pergunte ao The Judge": a garantia de só leitura, a leitura da resposta e o último julgamento.
//
// Nenhum caso aqui roda o `claude`: a garantia de que o juiz não publica nem escreve está na FORMA da
// linha de comando (medida à mão antes de virar código — ver o cabeçalho de `lib/juiz.mjs`), e é ela
// que se trava aqui. O portão da skill roda de verdade quando a skill está instalada.
//
// uso: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Juiz } from '../lib/juiz.mjs';

function pasta(nome) {
    return mkdtempSync(join(process.env.QUALIDADE_ESTADO || tmpdir(), `${nome}-`));
}

function comSkill(raiz) {
    mkdirSync(join(raiz, '.claude/skills/the-judge'), { recursive: true });
    writeFileSync(join(raiz, '.claude/skills/the-judge/SKILL.md'), '---\nname: the-judge\n---\n');
    return join(raiz, '.claude/skills/the-judge');
}

test('o botão só existe com a skill instalada, no workspace ou no usuário', () => {
    const ws = pasta('ws');
    const casa = pasta('casa');
    assert.equal(new Juiz({ workspace: ws, casa }).skill(), null);
    assert.equal(new Juiz({ workspace: ws, casa: comSkill(casa) && casa }).skill(), join(casa, '.claude/skills/the-judge'));
    assert.equal(new Juiz({ workspace: comSkill(ws) && ws, casa }).skill(), join(ws, '.claude/skills/the-judge'));
});

// O caso que importa. Com `--allowedTools` a escrita passou mesmo assim; é o `--restricted` com a lista
// fechada de `--tools` que tira Bash e escrita, e o `--strict-mcp-config` que tira os conectores.
test('o juiz roda só com leitura: sem Bash, sem escrita, sem conectores, sem esperar aprovação', () => {
    const args = new Juiz().argumentos({ prompt: 'x', skill: '/s', dir: '/d' });
    assert.ok(args.includes('--restricted'));
    const ferramentas = args[args.indexOf('--tools') + 1].split(',');
    assert.deepEqual(ferramentas.sort(), ['Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch']);
    assert.ok(args.includes('--strict-mcp-config'));
    assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
    assert.ok(!args.some(a => /^(Bash|Write|Edit|NotebookEdit)\b/.test(a)), 'nenhuma ferramenta que escreve ou executa');
    assert.ok(!args.includes('--dangerously-skip-permissions'));
    // A primeira corrida real voltou com "WebFetch e WebSearch foram negados": o passo 2 da skill
    // (pesquisa obrigatória) ficou vazio. Liberar as duas, e SÓ as duas.
    const i = args.indexOf('--allowedTools');
    const liberadas = args.slice(i + 1, args.findIndex((a, j) => j > i && a.startsWith('--')));
    assert.deepEqual(liberadas, ['WebSearch', 'WebFetch']);
});

test('a leitura fica confinada à skill e à pasta da corrida', () => {
    const args = new Juiz().argumentos({ prompt: 'x', skill: '/s', dir: '/d', sessao: 'abc' });
    const dirs = args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1]] : []));
    assert.deepEqual(dirs, ['/s', '/d']);
    assert.equal(args[args.indexOf('--resume') + 1], 'abc', 'a correção do portão continua a mesma sessão');
});

test('o prompt tira o passo 7 e não manda rodar nada', () => {
    const p = new Juiz().prompt({
        skill: '/s', dir: '/d', raiz: '/r', login: 'eu', revisoes: [], arquivos: [], lintado: 'ok', varredura: '',
        pr: { number: 1, title: 't', url: 'u', state: 'OPEN', author: { login: 'a' }, baseRefName: 'develop', headRefName: 'UND-1', headRefOid: 'abc', additions: 1, deletions: 0, changedFiles: 1, body: '' }
    });
    assert.match(p, /Passo 7 \(publicar\): NÃO existe/);
    assert.ok(!/post_review/.test(p), 'o prompt não pode nem citar o script que publica');
    assert.match(p, /Testes: NÃO rodados/);
    assert.match(p, /português do Brasil/);
});

test('a resposta vira JSON: último bloco ```json, ou o objeto solto; o resto é nulo', () => {
    const j = new Juiz();
    assert.deepEqual(j.extrairJson('rascunho ```json\n{"a":1}\n``` final ```json\n{"verdict":"APPROVE"}\n```'), { verdict: 'APPROVE' });
    assert.deepEqual(j.extrairJson('aqui: {"verdict":"COMMENT","findings":[]} fim'), { verdict: 'COMMENT', findings: [] });
    assert.equal(j.extrairJson('não sei'), null);
    assert.equal(j.extrairJson('```json\n[1,2]\n```'), null);
    assert.equal(j.extrairJson(''), null);
});

// `crohc` e `crohc-server` no mesmo chamado: com `-` de separador, o último de um era lido como do outro.
test('o último julgamento é do par chamado × repo exato, e o mais recente', () => {
    const j = new Juiz();
    const gravar = (nome, conteudo) => {
        mkdirSync(join(j.base(), nome), { recursive: true });
        writeFileSync(join(j.base(), nome, 'resultado.json'), JSON.stringify(conteudo));
    };
    gravar('UND-9__crohc__2026-10-19T10-00-00-000Z', { qual: 'crohc velho' });
    gravar('UND-9__crohc__2026-10-19T11-00-00-000Z', { qual: 'crohc novo' });
    gravar('UND-9__crohc-server__2026-10-19T12-00-00-000Z', { qual: 'server' });
    mkdirSync(join(j.base(), 'UND-9__crohc__2026-10-19T13-00-00-000Z'), { recursive: true });
    assert.equal(j.ultimo('UND-9', 'crohc').qual, 'crohc novo', 'corrida sem resultado (rodando, ou caiu) é pulada');
    assert.equal(j.ultimo('UND-9', 'crohc-server').qual, 'server');
    assert.equal(j.ultimo('UND-9', 'outro'), null);
});

const instalada = new Juiz().skill();
test('o portão de verdade da skill aceita um julgamento mínimo bem formado', { skip: !instalada && 'skill the-judge não instalada' }, async () => {
    const dir = pasta('portao');
    writeFileSync(join(dir, 'findings.json'), JSON.stringify({
        language: 'pt', round: 1, carryover: { blocker: 0, 'should-fix': 0 }, verdict: 'APPROVE',
        summary: '## TL;DR\nA PR troca um texto. APPROVE.\n## Findings\nnenhum\n## Promote to lint rule\nnone\n## Research log\nno external surfaces touched\n## Checks run\nlint ok\n## Skipped files\nnenhum',
        findings: []
    }));
    const r = await new Juiz()._portao(instalada, dir);
    assert.equal(r.ok, true, r.saida);
    assert.ok(existsSync(join(dir, 'findings.json')));
});

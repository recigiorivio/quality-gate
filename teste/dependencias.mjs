// O (i) da tela e o `instalacao/verificar.mjs` leem a mesma lista: aqui se trava a forma dela e as
// diferenças entre conferir no terminal e conferir dentro da tela.
//
// uso: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Dependencias } from '../lib/dependencias.mjs';

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));

test('cada item diz o grupo, o estado, o nome e para que serve', async () => {
    const { itens } = await new Dependencias({ raiz: RAIZ }).listar();
    for (const i of itens) {
        assert.ok(['obrigatório', 'recomendado', 'opcional'].includes(i.grupo), i.nome);
        assert.ok(['ok', 'aviso', 'falta'].includes(i.estado), i.nome);
        assert.ok(i.nome && i.papel, `sem nome ou papel: ${JSON.stringify(i)}`);
    }
    assert.equal(itens.find(i => i.nome.startsWith('node ')).estado, 'ok');
});

// Dentro da tela a porta é dela mesma: a checagem respondia "em uso" sempre.
test('na tela não há checagem de porta, e o node vem com o caminho do executável', async () => {
    const noTerminal = await new Dependencias({ raiz: RAIZ }).listar();
    const naTela = await new Dependencias({ raiz: RAIZ, naTela: true }).listar();
    assert.ok(noTerminal.itens.some(i => i.nome === 'porta 4100'));
    assert.ok(!naTela.itens.some(i => i.nome === 'porta 4100'));
    assert.ok(naTela.itens.find(i => i.nome.startsWith('node ')).nome.includes(process.execPath));
});

test('sem repos e sem a skill do juiz: avisos, com o que fazer', async () => {
    const vazio = mkdtempSync(join(tmpdir(), 'dep-'));
    try {
        const { itens, faltando } = await new Dependencias({ raiz: RAIZ, workspace: vazio, casa: vazio }).listar();
        const pasta = itens.find(i => i.papel.startsWith('a pasta com os repos'));
        assert.equal(pasta.estado, 'aviso');
        assert.match(pasta.nota, /nenhum repo git/);
        const juiz = itens.find(i => i.nome === 'skill the-judge');
        assert.equal(juiz.estado, 'aviso');
        assert.match(juiz.nota, /install --skill the-judge/);
        assert.equal(faltando, 0);
    } finally {
        rmSync(vazio, { recursive: true, force: true });
    }
});

test('a skill achada no workspace conta, mesmo sem a da casa', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'dep-'));
    try {
        mkdirSync(join(ws, '.claude/skills/the-judge'), { recursive: true });
        writeFileSync(join(ws, '.claude/skills/the-judge/SKILL.md'), '# the-judge');
        const { itens } = await new Dependencias({ raiz: RAIZ, workspace: ws, casa: ws }).listar();
        assert.match(itens.find(i => i.papel === 'o botão Pergunte ao The Judge').nome, /^skill the-judge · /);
    } finally {
        rmSync(ws, { recursive: true, force: true });
    }
});

test('o verificar do terminal imprime a mesma lista e sai com 0 quando nada obrigatório falta', () => {
    const saida = execFileSync(process.execPath, [join(RAIZ, 'instalacao/verificar.mjs')], { encoding: 'utf8' });
    assert.match(saida, /^obrigatório$/m);
    assert.match(saida, /ok {5}node /);
    assert.match(saida, /Pronto para rodar: npm start/);
});

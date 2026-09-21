// O registro dos gatilhos no `.claude/settings.json` do workspace.
//
// É o único lugar do projeto que escreve em arquivo de configuração de OUTRA ferramenta, e o modo
// de falha aqui não é erro na tela: é a pessoa perder as permissões que tinha, ou desinstalar um
// clone e desligar o gatilho do outro. Os casos abaixo cobram isso.
//
// uso: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    caminhoSettings, lerSettings, gravarSettings, comGatilhos, semGatilhos,
    jaRegistrados, outrosClones, plantados, removerPlantados, faltando, plantar, caminhoPadrao
} from '../lib/gatilhos.mjs';
import { CONFIGS } from '../lib/configs.mjs';

const CLONE = '/ws/quality-gate';
const OUTRO = '/ws/qualidade';

function workspaceComSettings(conteudo) {
    const ws = mkdtempSync(join(tmpdir(), 'qualidade-gatilhos-'));
    mkdirSync(join(ws, '.claude'), { recursive: true });
    if (conteudo !== undefined) {
        writeFileSync(caminhoSettings(ws), conteudo);
    }
    return ws;
}

function comOClone(projeto, evento = 'UserPromptSubmit') {
    return {
        hooks: {
            [evento]: [{ hooks: [{ type: 'command', command: `node ${projeto}/hook/gate.mjs prompt` }] }]
        }
    };
}

test('add é idempotente: rodar duas vezes não duplica entrada', () => {
    const uma = comGatilhos({}, CLONE);
    const duas = comGatilhos(uma, CLONE);
    assert.deepEqual(duas, uma);
    assert.equal(duas.hooks.UserPromptSubmit.length, 1);
});

test('add preserva o que já estava no settings', () => {
    const antes = { permissions: { allow: ['Bash(ls:*)'] }, model: 'opus' };
    const depois = comGatilhos(antes, CLONE);
    assert.deepEqual(depois.permissions, antes.permissions);
    assert.equal(depois.model, 'opus');
    assert.equal(jaRegistrados(depois, CLONE).length, 3);
});

// O caso que justifica a remoção ser por caminho e não por evento: dois clones conviviam, e apagar
// "os hooks do gate" desligava o do vizinho junto.
test('remove tira só o clone pedido e deixa o outro de pé', () => {
    let s = comGatilhos(comOClone(OUTRO), CLONE);
    assert.equal(s.hooks.UserPromptSubmit.length, 2);
    s = semGatilhos(s, CLONE);
    assert.deepEqual(jaRegistrados(s, CLONE), []);
    assert.deepEqual(jaRegistrados(s, OUTRO), ['UserPromptSubmit']);
});

test('remove não deixa grupo nem evento vazio para trás', () => {
    const s = semGatilhos(comGatilhos({}, CLONE), CLONE);
    assert.equal(s.hooks, undefined);
});

test('remove preserva hook de terceiro no mesmo evento', () => {
    const terceiro = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node /outro/lugar/gate.mjs pretooluse' }] }] } };
    const s = semGatilhos(comGatilhos(terceiro, CLONE), CLONE);
    assert.equal(s.hooks.PreToolUse.length, 1);
    assert.match(s.hooks.PreToolUse[0].hooks[0].command, /\/outro\/lugar\//);
});

// `gate.mjs` de outro projeto não é clone do quality-gate: avisar de duplicação que não existe
// ensina a ignorar o aviso.
test('só conta como outro clone o que está em hook/gate.mjs', () => {
    assert.deepEqual(outrosClones(comOClone(OUTRO), CLONE), [`${OUTRO}/hook/gate.mjs`]);
    const alheio = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node /x/gate.mjs pretooluse' }] }] } };
    assert.deepEqual(outrosClones(alheio, CLONE), []);
    assert.deepEqual(outrosClones(comOClone(CLONE), CLONE), []);
});

test('settings ilegível recusa em vez de sobrescrever', () => {
    const ws = workspaceComSettings('{ isto não é json }');
    assert.throws(() => lerSettings(caminhoSettings(ws)), /não é JSON válido/);
});

test('settings inexistente não é erro, e gravar não pede backup do que não existe', () => {
    const ws = workspaceComSettings(undefined);
    const { settings, existia } = lerSettings(caminhoSettings(ws));
    assert.equal(existia, false);
    assert.equal(gravarSettings(caminhoSettings(ws), comGatilhos(settings, CLONE)), null);
    assert.equal(jaRegistrados(lerSettings(caminhoSettings(ws)).settings, CLONE).length, 3);
});

test('gravar guarda .bak do que estava lá', () => {
    const ws = workspaceComSettings('{"model":"opus"}');
    const backup = gravarSettings(caminhoSettings(ws), comGatilhos({ model: 'opus' }, CLONE));
    assert.equal(readFileSync(backup, 'utf8'), '{"model":"opus"}');
});

// Rotina plantada é ponto de partida, e a pessoa edita. Apagar sem cópia perderia o texto dela.
test('remover rotina plantada guarda .bak com a edição', () => {
    const ws = workspaceComSettings('{}');
    const alvo = join(ws, CONFIGS.fim.caminho);
    mkdirSync(join(ws, '.claude/commands'), { recursive: true });
    writeFileSync(alvo, 'rotina com MINHA EDICAO');
    assert.equal(plantados(ws).length, 1);
    assert.deepEqual(removerPlantados(ws), [CONFIGS.fim.caminho]);
    assert.equal(existsSync(alvo), false);
    assert.equal(readFileSync(`${alvo}.bak`, 'utf8'), 'rotina com MINHA EDICAO');
    assert.deepEqual(plantados(ws), []);
});

// O prefixo `quality-` é o que faz a instalação conviver com a rotina que o time já tem, e é por
// ele que a desinstalação reconhece o que é dela. Perder o prefixo num rename silencioso faria a
// instalação voltar a disputar nome com arquivo alheio.
test('todo caminho plantado leva o prefixo quality-', () => {
    for (const c of Object.values(CONFIGS)) {
        assert.match(c.caminho, /\/quality-[a-z-]+\.md$/, c.caminho);
    }
});

// Cada chave do CONFIGS promete um arquivo em `padroes/`. Chave sem padrão nunca é oferecida nem
// plantada: entra calada no mapa e não aparece em lugar nenhum.
test('toda chave do CONFIGS tem padrão no disco', () => {
    for (const [chave, c] of Object.entries(CONFIGS)) {
        assert.ok(existsSync(caminhoPadrao(c.caminho)), `${chave} sem padrão: ${caminhoPadrao(c.caminho)}`);
    }
});

// O buraco que isto fecha: padrão acrescentado numa versão nova não alcançava quem já tinha passado
// pelo portão da primeira abertura — o arquivo existia no repo e nunca chegava a ninguém.
test('faltando() acha o que o CONFIGS promete e o workspace não tem', () => {
    const ws = workspaceComSettings('{}');
    assert.equal(faltando(ws).length, Object.keys(CONFIGS).length);
    mkdirSync(join(ws, '.claude/commands'), { recursive: true });
    writeFileSync(join(ws, CONFIGS.fim.caminho), 'ja existe');
    assert.ok(!faltando(ws).some(f => f.chave === 'fim'));
});

test('plantar() escreve o padrão e não toca no que já existe', () => {
    const ws = workspaceComSettings('{}');
    mkdirSync(join(ws, '.claude/commands'), { recursive: true });
    writeFileSync(join(ws, CONFIGS.inicio.caminho), 'MINHA rotina');
    const escritos = plantar(ws, Object.keys(CONFIGS));
    assert.ok(!escritos.includes(CONFIGS.inicio.caminho), 'não sobrescreve');
    assert.equal(readFileSync(join(ws, CONFIGS.inicio.caminho), 'utf8'), 'MINHA rotina');
    assert.ok(escritos.includes(CONFIGS.subir.caminho));
    assert.deepEqual(faltando(ws), []);
});

// O plist do LaunchAgent.
//
// Só as funções puras rodam aqui: `instalar()` e `remover()` mexem em `~/Library/LaunchAgents` e
// chamam `launchctl`, e teste que carrega agente de verdade na máquina de quem roda a suíte é o
// mesmo erro que o `.env` do teste de tela cometeu.
//
// Cada caso abaixo é um jeito medido de o agente subir e a tela ficar meia-boca em silêncio.
//
// uso: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotulo, caminhoPlist, caminhoLog, plist, projetoDoPlist, suportado, PORTA_PADRAO } from '../lib/servico.mjs';

const CLONE = '/ws/quality-gate';
const OUTRO = '/ws/qualidade';

test('o rótulo é estável e distingue clones: dois agentes podem coexistir', () => {
    assert.equal(rotulo(CLONE), rotulo(CLONE));
    assert.notEqual(rotulo(CLONE), rotulo(OUTRO));
    assert.match(rotulo(CLONE), /^quality-gate\.[0-9a-f]{8}$/);
});

test('o plist mora em ~/Library/LaunchAgents com o nome do rótulo', () => {
    assert.equal(caminhoPlist(CLONE), join(homedir(), 'Library/LaunchAgents', `${rotulo(CLONE)}.plist`));
});

// O launchd não resolve nome de programa pelo PATH. `node` solto no plist sobe nada e a única
// pista é uma linha no log do sistema.
test('o node entra por caminho absoluto', () => {
    const p = plist(CLONE, { node: '/abs/bin/node' });
    assert.match(p, /<string>\/abs\/bin\/node<\/string>/);
    assert.ok(!/<string>node<\/string>/.test(p), 'node solto no plist não sobe');
});

// O caso que mais dói: PATH padrão do launchd é `/usr/bin:/bin:/usr/sbin:/sbin`, e o `gh` mora em
// `/opt/homebrew/bin`. Sem assar o PATH a tela sobe e perde PR, base observada e checks — sem erro.
test('o PATH de quem instalou é assado no plist', () => {
    const p = plist(CLONE, { path: '/opt/homebrew/bin:/usr/bin:/bin' });
    assert.match(p, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>/);
});

// `path: undefined` NÃO exercita isto — o default do destructuring troca por `process.env.PATH`.
// Só PATH vazio chega ao fallback, e plist com PATH vazio faz o servidor não achar nem o `git`.
test('PATH vazio cai no mínimo do launchd em vez de ir vazio para o plist', () => {
    assert.match(plist(CLONE, { path: '' }), /<key>PATH<\/key><string>\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
});

test('a porta vai para o ambiente, e o padrão é 4100', () => {
    assert.match(plist(CLONE), new RegExp(`<key>PORT</key><string>${PORTA_PADRAO}</string>`));
    assert.match(plist(CLONE, { porta: 4200 }), /<key>PORT<\/key><string>4200<\/string>/);
});

test('sobe no load, volta sozinho, e o stdout não vira arquivo que só cresce', () => {
    const p = plist(CLONE);
    assert.match(p, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(p, /<key>KeepAlive<\/key><true\/>/);
    assert.match(p, /<key>StandardOutPath<\/key><string>\/dev\/null<\/string>/);
    assert.match(p, new RegExp(`<key>StandardErrorPath</key><string>${caminhoLog(CLONE)}</string>`));
});

// É por ele que o `--status` e o aviso de disputa de porta sabem de qual clone é um agente alheio.
test('o WorkingDirectory identifica o clone, e volta pela leitura', () => {
    assert.match(plist(CLONE), new RegExp(`<key>WorkingDirectory</key><string>${CLONE}</string>`));
    const tmp = join(process.env.QUALIDADE_ESTADO || tmpdir(), `plist-${Date.now()}.plist`);
    writeFileSync(tmp, plist(CLONE));
    assert.equal(projetoDoPlist(tmp), CLONE);
    rmSync(tmp, { force: true });
});

test('caminho com & ou < não quebra o XML', () => {
    const p = plist('/ws/a & b <x>');
    assert.ok(!/&(?!amp;|lt;|gt;)/.test(p), 'e comercial solto invalida o plist');
    assert.match(p, /a &amp; b &lt;x&gt;/);
});

// Assar o PATH da sessão trouxe `/var/folders/.../T/cmux-cli-shims/<uuid>` e cache de plugin com
// versão pinada para dentro de um plist que atravessa reboot. Entrada morta não quebra, mas no dia
// em que o caminho existir de novo com outro conteúdo, o serviço acha binário que ninguém pediu.
test('o PATH assado não leva diretório temporário da sessão', () => {
    const p = plist(CLONE, { path: `${tmpdir()}/cmux-cli-shims/abc:/tmp/x:/opt/homebrew/bin:/usr/bin` });
    assert.match(p, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
    assert.ok(!p.includes('cmux-cli-shims'), 'shim de sessão não entra no plist');
});

test('PATH que era só temporário não vira PATH vazio', () => {
    assert.match(plist(CLONE, { path: `${tmpdir()}/so-isso` }),
        /<key>PATH<\/key><string>\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
});

test('suportado() só em macOS — LaunchAgent não existe em outro lugar', () => {
    assert.equal(suportado(), process.platform === 'darwin');
});

// O app de Mac: o Info.plist que a construção escreve e o que o Swift lê dele.
//
// Nada aqui escreve em `~/Applications`: estado e remoção rodam contra um bundle falso numa pasta
// temporária, pelo mesmo motivo do `servico.mjs` — teste que instala app na máquina de quem roda a
// suíte é o erro que o `.env` do teste de tela cometeu. A única coisa que toca o compilador é a
// checagem de tipos do fonte, e ela é pulada sem `swiftc`.
//
// uso: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { infoPlist, estado, remover, construir, lerInfo, portaDaTela, hashFonte, suportado, swiftc, ID, FONTE } from '../lib/app.mjs';
import { rotulo } from '../lib/servico.mjs';

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));
const CLONE = '/ws/quality-gate';
const OUTRO = '/ws/qualidade';
const naoMac = !suportado() && 'só macOS';

function pasta() {
    return mkdtempSync(join(process.env.QUALIDADE_ESTADO || tmpdir(), 'app-'));
}

function bundleFalso(conteudoPlist) {
    const destino = join(pasta(), 'Quality Gate.app');
    mkdirSync(join(destino, 'Contents'), { recursive: true });
    writeFileSync(join(destino, 'Contents/Info.plist'), conteudoPlist);
    return destino;
}

// App aberto pelo Finder herda o PATH mínimo do launchd: sem node absoluto ele não sobe a tela, e
// sem o PATH assado ela sobe sem `gh` — sem PR, base observada nem checks.
test('o node entra por caminho absoluto, e o PATH de quem construiu é assado', () => {
    const p = infoPlist(CLONE, { node: '/abs/bin/node', path: '/opt/homebrew/bin:/usr/bin:/bin' });
    assert.match(p, /<key>QGNode<\/key><string>\/abs\/bin\/node<\/string>/);
    assert.match(p, /<key>QGPath<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>/);
});

// O rótulo é o que deixa o app preferir o LaunchAgent a subir um servidor próprio na mesma porta.
test('a porta e o rótulo do LaunchAgent deste clone vão para o Info.plist', () => {
    const p = infoPlist(CLONE, { porta: 4200 });
    assert.match(p, /<key>QGPorta<\/key><string>4200<\/string>/);
    assert.match(p, new RegExp(`<key>QGRotulo</key><string>${rotulo(CLONE).replace('.', '\\.')}</string>`));
});

// Sem LaunchAgent deste clone, vale o `PORT` como no servidor; o caso com agente lê `~/Library` e fica de fora.
test('sem LaunchAgent, a porta da tela é o PORT, e na falta dele a 4100', () => {
    assert.equal(portaDaTela(CLONE, { PORT: '4321' }), 4321);
    assert.equal(portaDaTela(CLONE, {}), 4100);
});

// O de-para que impede "metade implementado": chave escrita que o Swift não lê é configuração
// morta, e chave lida que ninguém escreve cai calada no valor padrão do Swift.
test('toda chave QG que o Swift lê é escrita pela construção, e só commit e hash sobram', () => {
    const swift = readFileSync(join(RAIZ, FONTE), 'utf8');
    const lidas = new Set([...swift.matchAll(/info\["(QG\w+)"\]/g)].map(m => m[1]));
    const escritas = new Set([...infoPlist(CLONE).matchAll(/<key>(QG\w+)<\/key>/g)].map(m => m[1]));
    assert.ok(lidas.size >= 5, `o Swift lê ${lidas.size} chaves — a regex deixou de casar?`);
    for (const chave of lidas) {
        assert.ok(escritas.has(chave), `o Swift lê ${chave}, e a construção não escreve`);
    }
    assert.deepEqual([...escritas].filter(c => !lidas.has(c)), ['QGCommit', 'QGFonte']);
});

test('a rede liberada é só a local', () => {
    const p = infoPlist(CLONE);
    assert.match(p, /<key>NSAllowsLocalNetworking<\/key><true\/>/);
    assert.ok(!p.includes('NSAllowsArbitraryLoads'), 'o app só fala com 127.0.0.1');
});

test('o Info.plist é válido, e caminho com & ou < volta intacto pela leitura', { skip: naoMac }, () => {
    const destino = bundleFalso(infoPlist('/ws/a & b <x>', { commit: 'abc1234' }));
    const plist = join(destino, 'Contents/Info.plist');
    execFileSync('plutil', ['-lint', plist], { stdio: 'ignore' });
    assert.equal(lerInfo(plist).QGClone, '/ws/a & b <x>');
    assert.equal(lerInfo(plist).CFBundleIdentifier, ID);
});

// A leitura antiga era regex sobre o texto, e o `plutil -replace` reformata o arquivo: o app deixava
// de ser reconhecido como nosso, e a reconstrução se recusava a sobrescrever o próprio app.
test('o app continua reconhecido depois de outra ferramenta regravar o Info.plist', { skip: naoMac }, () => {
    const destino = bundleFalso(infoPlist(CLONE));
    execFileSync('plutil', ['-replace', 'QGPorta', '-string', '4300', join(destino, 'Contents/Info.plist')]);
    const e = estado(CLONE, destino);
    assert.equal(e.nosso, true);
    assert.equal(e.meu, true);
    assert.equal(e.porta, 4300);
});

test('estado distingue o app deste clone, o de outro clone e um app alheio', { skip: naoMac }, () => {
    assert.deepEqual(
        [estado(CLONE, bundleFalso(infoPlist(CLONE))), estado(CLONE, bundleFalso(infoPlist(OUTRO)))]
            .map(e => [e.nosso, e.meu, e.clone]),
        [[true, true, CLONE], [true, false, OUTRO]]);
    const alheio = estado(CLONE, bundleFalso(infoPlist(CLONE).replace(ID, 'com.exemplo.outro')));
    assert.equal(alheio.nosso, false);
    assert.equal(estado(CLONE, join(pasta(), 'nada.app')).instalado, false);
});

// Comparar por commit dava "desatualizado" num app recém-construído de árvore com mudança não commitada.
test('desatualizado compara o conteúdo do fonte, não o commit', { skip: naoMac }, () => {
    const clone = pasta();
    mkdirSync(join(clone, 'mac'));
    writeFileSync(join(clone, FONTE), '// v1');
    writeFileSync(join(clone, 'mac/icone.svg'), '<svg/>');
    const destino = bundleFalso(infoPlist(clone, { commit: 'abc1234', fonte: hashFonte(clone) }));
    assert.equal(estado(clone, destino).desatualizado, false);
    writeFileSync(join(clone, FONTE), '// v2');
    assert.equal(estado(clone, destino).desatualizado, true);
});

// Mesma regra do LaunchAgent: desinstalar um clone não leva o que é de outro.
test('remover só apaga o app deste clone', { skip: naoMac }, () => {
    const doOutro = bundleFalso(infoPlist(OUTRO));
    assert.equal(remover(CLONE, doOutro).removido, false);
    assert.ok(existsSync(doOutro));
    const alheio = bundleFalso(infoPlist(CLONE).replace(ID, 'com.exemplo.outro'));
    assert.equal(remover(CLONE, alheio).removido, false);
    const meu = bundleFalso(infoPlist(CLONE));
    assert.equal(remover(CLONE, meu).removido, true);
    assert.ok(!existsSync(meu));
});

test('construir se recusa a sobrescrever um app que não é o quality-gate', { skip: naoMac }, () => {
    const alheio = bundleFalso(infoPlist(CLONE).replace(ID, 'com.exemplo.outro'));
    const r = construir(CLONE, { destino: alheio });
    assert.equal(r.ok, false);
    assert.match(r.erro, /não é o quality-gate/);
    assert.ok(existsSync(join(alheio, 'Contents/Info.plist')));
});

// O renderizador de SVG do `sips` ignora `<filter>`: sombra feita com `feDropShadow` some sem erro,
// e o ícone sai chapado. Medido ao desenhar este ícone.
test('o ícone está na grade de 1024 e não depende de filtro', () => {
    const svg = readFileSync(join(RAIZ, 'mac/icone.svg'), 'utf8');
    assert.match(svg, /viewBox="0 0 1024 1024"/);
    assert.ok(!/<(filter|feDropShadow|feGaussianBlur)\b/.test(svg), 'filtro some no sips');
});

test('o fonte Swift compila', { skip: !swiftc() && 'sem swiftc', timeout: 300000 }, () => {
    const saida = pasta();
    try {
        execFileSync('xcrun', ['swiftc', '-parse-as-library', '-typecheck', join(RAIZ, FONTE)],
            { stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000, env: { ...process.env, TMPDIR: saida } });
    } catch (e) {
        assert.fail(`${e.stderr || e.message}`.slice(0, 2000));
    } finally {
        rmSync(saida, { recursive: true, force: true });
    }
});

// O app de Windows: o .ico, o config.json que o lançador lê, o atalho e a construção inteira.
//
// Roda em qualquer sistema. O que é só do Windows (o PowerShell do lançador e do atalho) fica de fora
// por desenho: a construção aceita o navegador e `criarAtalho: false` de fora, e aqui o Chrome, que é o
// mesmo motor do Edge, faz o papel dele quando existe. O resto pula com o motivo dito.
//
// uso: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as w from '../lib/app-windows.mjs';

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));
const CLONE = 'C:\\ws\\quality-gate';
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']
    .find(c => existsSync(c));

function pasta(nome) {
    return mkdtempSync(join(process.env.QUALIDADE_ESTADO || tmpdir(), `${nome}-`));
}

// PNG falso basta para o formato: o .ico só guarda os bytes e diz onde cada um começa.
test('o .ico tem o cabeçalho, uma entrada por tamanho e cada PNG no deslocamento que a entrada diz', () => {
    const png = n => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(n)]);
    const pngs = [{ lado: 256, png: png(10) }, { lado: 32, png: png(5) }];
    const b = w.ico(pngs);
    assert.deepEqual([b.readUInt16LE(0), b.readUInt16LE(2), b.readUInt16LE(4)], [0, 1, 2]);
    assert.equal(b.readUInt8(6), 0, 'lado 256 se escreve 0: o campo tem um byte');
    assert.equal(b.readUInt8(6 + 16), 32);
    for (const [i, { png: p }] of pngs.entries()) {
        const entrada = 6 + 16 * i;
        assert.equal(b.readUInt16LE(entrada + 6), 32, '32 bits por pixel');
        assert.equal(b.readUInt32LE(entrada + 8), p.length);
        const inicio = b.readUInt32LE(entrada + 12);
        assert.deepEqual(b.subarray(inicio, inicio + p.length), p);
    }
});

test('o Edge é procurado nos três lugares em que ele se instala', () => {
    const env = { 'ProgramFiles(x86)': 'C:\\PF86', ProgramFiles: 'C:\\PF', LOCALAPPDATA: 'C:\\LA' };
    const so = alvo => c => c.startsWith(alvo);
    assert.match(w.navegador(env, so('C:\\PF86')), /PF86.*msedge\.exe$/);
    assert.match(w.navegador(env, so('C:\\LA')), /LA.*msedge\.exe$/);
    assert.equal(w.navegador(env, () => false), null);
});

// O de-para do app de Mac, do lado do Windows: chave que o lançador lê e ninguém grava vira `$null` no
// PowerShell, e a mensagem de erro sai com um caminho vazio.
test('toda chave que o lançador lê do config.json é gravada pela construção', () => {
    const ps1 = readFileSync(join(RAIZ, w.LANCADOR), 'utf8');
    const lidas = new Set([...ps1.matchAll(/\$config\.(\w+)/g)].map(m => m[1]));
    const gravadas = new Set(Object.keys(w.config(CLONE)));
    assert.ok(lidas.size >= 3, `o lançador lê ${lidas.size} chaves — a regex deixou de casar?`);
    for (const chave of lidas) {
        assert.ok(gravadas.has(chave), `o lançador lê ${chave}, e a construção não grava`);
    }
    assert.equal(w.config(CLONE).app, 'quality-gate', 'a marca que separa a nossa pasta de outra qualquer');
});

test('o lançador sonda pelo ícone, usa perfil próprio do Edge e só derruba o servidor que subiu', () => {
    const ps1 = readFileSync(join(RAIZ, w.LANCADOR), 'utf8');
    assert.match(ps1, /favicon\.svg/);
    assert.match(ps1, /-match 'quality-gate'/);
    assert.match(ps1, /--user-data-dir=/, 'sem perfil próprio a janela vira do Edge aberto e não há como esperar ela fechar');
    assert.match(ps1, /if \(\$servidor -and -not \$servidor\.HasExited\)/);
});

test('o atalho roda o lançador escondido, e caminho com aspas simples não quebra o PowerShell', () => {
    const s = w.scriptAtalho({ atalho: "C:\\Users\\D'Avila\\Quality Gate.lnk", pasta: "C:\\Users\\D'Avila\\QualityGate", icone: 'C:\\x\\QualityGate.ico' });
    assert.match(s, /CreateShortcut\('C:\\Users\\D''Avila\\Quality Gate\.lnk'\)/);
    assert.match(s, /-WindowStyle Hidden/);
    assert.match(s, /-ExecutionPolicy Bypass/);
    assert.match(s, /-File "C:\\Users\\D''Avila\\QualityGate\\QualityGate\.ps1"/);
    assert.match(s, /IconLocation = 'C:\\x\\QualityGate\.ico,0'/);
    assert.ok(!/IconLocation/.test(w.scriptAtalho({ atalho: 'a', pasta: 'p', icone: null })), 'sem ícone, o do PowerShell');
});

test('estado e remoção: só a pasta com a marca, e só a deste clone', () => {
    const marcada = (clone, marca = 'quality-gate') => {
        const p = pasta('win');
        writeFileSync(join(p, 'config.json'), JSON.stringify({ ...w.config(clone), app: marca }));
        return p;
    };
    const atalho = join(pasta('atalho'), 'Quality Gate.lnk');
    assert.deepEqual(['nosso', 'meu'].map(k => w.estado(CLONE, { pasta: marcada(CLONE), atalho })[k]), [true, true]);
    assert.equal(w.estado(CLONE, { pasta: marcada(CLONE, 'outra-coisa'), atalho }).nosso, false);
    assert.equal(w.remover(CLONE, { pasta: marcada('C:\\outro'), atalho }).removido, false);
    const minha = marcada(CLONE);
    assert.equal(w.remover(CLONE, { pasta: minha, atalho }).removido, true);
    assert.ok(!existsSync(minha));
});

test('construir se recusa a sobrescrever uma pasta QualityGate que não é nossa', () => {
    const alheia = pasta('alheia');
    writeFileSync(join(alheia, 'config.json'), JSON.stringify({ app: 'outro-programa' }));
    const r = w.construir(RAIZ, { pasta: alheia, atalho: join(alheia, 'a.lnk'), exe: '/nao/existe', criarAtalho: false });
    assert.equal(r.ok, false);
    assert.match(r.erro, /não é do quality-gate/);
});

// O caminho inteiro menos o atalho: lançador com BOM, config, e o .ico renderizado pelo motor do Edge.
test('a construção grava o lançador com BOM, o config e um .ico de verdade', { skip: !CHROME && 'sem Chrome/Chromium para fazer o papel do Edge', timeout: 120000 }, () => {
    const destino = pasta('construido');
    const r = w.construir(RAIZ, { porta: 4321, pasta: destino, atalho: join(destino, 'a.lnk'), exe: CHROME, criarAtalho: false });
    assert.equal(r.ok, true, r.erro);
    assert.equal(r.icone, true, 'o Chromium sem cabeça não gerou o ícone');
    const ps1 = readFileSync(join(destino, 'QualityGate.ps1'));
    assert.deepEqual([...ps1.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'sem BOM o PowerShell 5.1 quebra os acentos');
    const ico = readFileSync(join(destino, 'QualityGate.ico'));
    assert.deepEqual([ico.readUInt16LE(2), ico.readUInt16LE(4)], [1, 4]);
    const primeiro = ico.readUInt32LE(6 + 12);
    assert.deepEqual([...ico.subarray(primeiro, primeiro + 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG dentro do .ico');
    const e = w.estado(RAIZ, { pasta: destino, atalho: join(destino, 'a.lnk') });
    assert.deepEqual([e.meu, e.porta, e.desatualizado], [true, 4321, false]);
});

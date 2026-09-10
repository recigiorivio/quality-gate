// Confere que cada regra declarada no doutrina.json existe de fato como checagem, e que a flag
// `corrige` bate com o que o `--corrigir` realmente apaga.
//
// Motivo: "migration não leva comentário NEM console.log" é UMA frase da doutrina e ficou implementada
// pela metade — só o console.log. Comentário de 2 linhas numa migration passava inteiro, e ninguém
// tinha como saber. Este teste transforma esse tipo de furo em falha vermelha.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChecarDiff } from '../ferramentas/checar-diff.mjs';
import { recusarEstadoDeProducao } from './anteparo.mjs';

recusarEstadoDeProducao();

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));
const doutrina = JSON.parse(readFileSync(join(RAIZ, 'doutrina.json'), 'utf8'));
const implementadas = new Set(new ChecarDiff().regras.map(r => r.nome));

// O `--corrigir` decide o que apaga por uma lista interna; ela tem que bater com o de-para.
const CORRIGIVEIS = (() => {
    const fonte = readFileSync(join(RAIZ, 'ferramentas', 'checar-diff.mjs'), 'utf8');
    const bloco = fonte.match(/const CORRIGIVEIS = \[([\s\S]*?)\];/);
    return new Set([...bloco[1].matchAll(/'([a-z-]+)'/g)].map(m => m[1]));
})();

test('toda regra com checagem declarada existe de verdade', () => {
    const faltando = doutrina.regras
        .filter(r => r.checagem && !implementadas.has(r.checagem))
        .map(r => `${r.checagem}  (doutrina: ${r.doutrina})`);
    assert.deepEqual(faltando, [], `declarado no doutrina.json mas não implementado:\n  ${faltando.join('\n  ')}`);
});

test('toda checagem implementada está declarada no de-para', () => {
    const declaradas = new Set(doutrina.regras.map(r => r.checagem).filter(Boolean));
    const orfas = [...implementadas].filter(n => !declaradas.has(n));
    assert.deepEqual(orfas, [], `checagem sem linha no doutrina.json (de onde ela veio?):\n  ${orfas.join('\n  ')}`);
});

test('a flag corrige bate com o que o --corrigir apaga', () => {
    const divergentes = [];
    for (const r of doutrina.regras.filter(x => x.checagem)) {
        const apaga = CORRIGIVEIS.has(r.checagem);
        if (Boolean(r.corrige) !== apaga) {
            divergentes.push(`${r.checagem}: doutrina.json diz corrige=${Boolean(r.corrige)}, código ${apaga ? 'apaga' : 'não apaga'}`);
        }
    }
    assert.deepEqual(divergentes, [], divergentes.join('\n  '));
});

test('regra sem checagem explica por que não tem', () => {
    const semJustificativa = doutrina.regras
        .filter(r => !r.checagem && !r.porque)
        .map(r => r.doutrina);
    assert.deepEqual(semJustificativa, [],
        `sem checagem e sem explicar por que:\n  ${semJustificativa.join('\n  ')}`);
});

test('toda regra que corrige tem exemplo do jeito certo E do errado no autoteste', () => {
    const fonte = readFileSync(join(RAIZ, 'ferramentas', 'checar-diff.mjs'), 'utf8');
    const casos = [...fonte.matchAll(/\['([a-z-]+)', '(errado|certo[a-z-]*)'/g)]
        .reduce((mapa, m) => {
            const [, regra, tipo] = m;
            mapa[regra] = mapa[regra] || new Set();
            mapa[regra].add(tipo.startsWith('certo') ? 'certo' : 'errado');
            return mapa;
        }, {});
    const semPar = [...CORRIGIVEIS].filter(n => !(casos[n]?.has('certo') && casos[n]?.has('errado')));
    assert.deepEqual(semPar, [],
        'checagem que APAGA código sem exemplo certo e errado no autoteste:\n  ' + semPar.join('\n  '));
});

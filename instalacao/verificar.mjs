// Confere os pré-requisitos e diz o que falta. Um script que descobre vale mais que uma lista que
// envelhece: se o `gh` sumir do PATH, a lista continua dizendo que está tudo certo.
// As checagens moram em `lib/dependencias.mjs`, as mesmas que o (i) da tela mostra.
//
// uso: node instalacao/verificar.mjs

import { aplicarEnv } from '../lib/env.mjs';
import { Dependencias } from '../lib/dependencias.mjs';

// O `.env` entra antes de resolver a raiz: é lá que o portão da primeira abertura grava a pasta
// escolhida, e sem isto o verificador conferia uma raiz diferente da que a tela usa.
aplicarEnv();

const MARCA = { ok: '  ok   ', falta: '  FALTA', aviso: '  aviso' };

const { itens, faltando } = await new Dependencias().listar();
let grupo = '';
for (const i of itens) {
    if (i.grupo !== grupo) {
        grupo = i.grupo;
        console.log(`\n${grupo}`);
    }
    console.log(`${MARCA[i.estado]}  ${i.nome}${i.nota ? `\n         ↳ ${i.nota}` : ''}`);
}
console.log(faltando
    ? `\n${faltando} pré-requisito(s) obrigatório(s) faltando.`
    : '\nPronto para rodar: npm start');
process.exit(faltando ? 1 : 0);

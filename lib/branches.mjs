// Os nomes de branch de longa vida do workspace, num lugar só.
//
// A detecção de pares da Implantação, a topologia do diff e a base observada do `contexto.mjs`
// tinham listas próprias, e a do `contexto.mjs` nem era lista: caía em `main`. Na troca de `stage` por `develop` (19/10/2026) o
// diff passou a ver `develop` e o resto não — o cartão de branch mandou o UND-2304 contra a `stage`
// já apagada, com "0 commit(s) na branch". Sem dependência de propósito: o `contexto.mjs` roda
// como processo à parte e não pode abrir o banco ao importar isto.
//
// A transição não é uniforme: medido no mesmo dia, 8 repos com `develop` e sem `stage`, dois
// (`evidencia-loader`, `rivio-deployment-cortex`) ainda só com `stage`, e dois com `desenv`. Por
// isso é preferência entre o que EXISTE em cada repo, nunca um nome único.

// Onde as branches de chamado mesclam. Ordem de preferência: a primeira que existir é a integração.
export const INTEGRACAO = ['develop', 'stage', 'desenv', 'homolog', 'hml'];

export const PRODUCAO = ['main', 'master', 'producao', 'prod'];

// Degrau entre integração e produção (`develop → stg → main`). Nunca é base de branch de chamado, e
// nunca destino de produção — mesmo quando é o `origin/HEAD` do remoto.
export const INTERMEDIARIAS = ['stg'];

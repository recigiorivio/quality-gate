// Recusa rodar teste contra o estado de PRODUÇÃO.
//
// Sem `QUALIDADE_ESTADO`, `caminhoEstado()` cai na raiz do projeto e a suíte grava decisão,
// catálogo, pontos e banco por cima dos dados reais de quem usa a ferramenta. Aconteceu QUATRO
// vezes num único dia de desenvolvimento — a escolha de repos do usuário foi apagada e restaurada
// à mão todas as vezes, porque a proteção era disciplina ("lembre de exportar a variável") em vez
// de código.
//
// Mora num módulo próprio, e não copiado em cada arquivo de teste, por dois motivos que custaram
// caro: o anteparo existia só no `smoke.mjs`, então `node --test teste/db.mjs` passava direto; e
// ele comparava com `resolve()`, que NÃO desfaz link simbólico — um `QUALIDADE_ESTADO` apontando
// para um link da raiz atravessava a checagem e a suíte arrancava contra a produção.
import { realpathSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caminhoEstado } from '../lib/db.mjs';

// `realpathSync` só funciona em caminho que existe; um diretório temporário recém-criado existe,
// e um que não existe não pode ser a raiz do projeto, que existe por definição.
const real = caminho => (existsSync(caminho) ? realpathSync(caminho) : caminho);

export function recusarEstadoDeProducao() {
    const raiz = dirname(dirname(fileURLToPath(import.meta.url)));
    if (real(caminhoEstado()) !== real(raiz)) {
        return;
    }
    throw new Error(`RECUSADO: teste apontado para o estado de PRODUÇÃO em ${raiz}.
Rode \`npm test\`, que já isola e limpa o temporário, ou passe um diretório na mão:
  QUALIDADE_ESTADO=$(mktemp -d) node --disable-warning=ExperimentalWarning --test teste/db.mjs`);
}

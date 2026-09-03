// Lê o `.env` do projeto. Existe porque o parser vivia dentro do `Stg` e o servidor também precisa:
// `QUALIDADE_HOST` no `.env` não fazia nada, porque o servidor só olhava o ambiente do shell.
//
// Zero dependência de propósito, como o resto do projeto — são cinco linhas de regex.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));

export function lerEnv(arquivo = join(RAIZ, '.env')) {
    if (!existsSync(arquivo)) {
        return null;
    }
    const env = {};
    for (const linha of readFileSync(arquivo, 'utf8').split('\n')) {
        const m = linha.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
        if (m) {
            env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
        }
    }
    return env;
}

// O shell GANHA do arquivo: `PORT=4199 npm test` tem que continuar mandando, e é a convenção que
// todo mundo espera de .env.
export function aplicarEnv(arquivo) {
    for (const [k, v] of Object.entries(lerEnv(arquivo) || {})) {
        if (process.env[k] === undefined) {
            process.env[k] = v;
        }
    }
}

// O linter de cada projeto, não um meu. Cada repo já tem `eslint.config.mjs` com os limites que quem
// mantém o repo calibrou (`complexity`, `max-depth`, `sonarjs/cognitive-complexity`) — melhor que
// qualquer número fixo que eu escolhesse. Nos Python, o `ruff` do venv, que é o mesmo que o CI roda.
//
// Roda só sobre os arquivos do diff: no repo inteiro um projeto grande leva segundos e acusa
// dezenas de problemas em código que ninguém tocou.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE } from './diff.mjs';

const execFileAsync = promisify(execFile);
const LIMITE_ACHADOS = 40;

export class Lint {
    // Qual linter serve este projeto, e para quais extensões.
    detectar(projeto) {
        const raiz = join(WORKSPACE, projeto);
        const linters = [];
        if (existsSync(join(raiz, 'eslint.config.mjs')) || existsSync(join(raiz, 'eslint.config.js'))) {
            linters.push({ nome: 'eslint', exts: /\.(js|mjs|cjs|jsx|ts|tsx)$/ });
        }
        for (const rel of ['.venv/bin/ruff', 'venv/bin/ruff']) {
            if (existsSync(join(raiz, rel))) {
                linters.push({ nome: 'ruff', exts: /\.py$/, bin: join(raiz, rel) });
                break;
            }
        }
        return linters;
    }

    async rodar(projeto, arquivos) {
        const raiz = join(WORKSPACE, projeto);
        const linters = this.detectar(projeto);
        if (!linters.length) {
            return { linters: [], achados: [], nota: 'nenhum linter configurado neste projeto' };
        }
        const achados = [];
        const usados = [];
        for (const linter of linters) {
            const alvos = arquivos.filter(a => linter.exts.test(a));
            if (!alvos.length) {
                continue;
            }
            usados.push(`${linter.nome} (${alvos.length} arquivo(s))`);
            const parte = linter.nome === 'eslint'
                ? await this._eslint(raiz, alvos)
                : await this._ruff(raiz, linter.bin, alvos);
            achados.push(...parte);
        }
        if (!usados.length) {
            return { linters: linters.map(l => l.nome), achados: [], nota: 'nenhum arquivo do diff é coberto pelos linters deste projeto' };
        }
        return { linters: usados, achados: achados.slice(0, LIMITE_ACHADOS), total: achados.length };
    }

    // eslint sai com código 1 quando acha erro: o erro do processo é o resultado, não uma falha.
    async _eslint(raiz, alvos) {
        const bruto = await this._exec('npx', ['eslint', '-f', 'json', '--no-error-on-unmatched-pattern', ...alvos], raiz);
        let lista;
        try {
            lista = JSON.parse(bruto.slice(bruto.indexOf('[')));
        } catch {
            return [];
        }
        const achados = [];
        for (const arq of lista) {
            const rel = arq.filePath.startsWith(raiz) ? arq.filePath.slice(raiz.length + 1) : arq.filePath;
            for (const m of arq.messages) {
                achados.push({
                    ferramenta: 'eslint',
                    arquivo: rel,
                    linha: m.line ?? 0,
                    regra: m.ruleId || 'parse',
                    severidade: m.severity === 2 ? 'erro' : 'aviso',
                    mensagem: m.message
                });
            }
        }
        return achados;
    }

    async _ruff(raiz, bin, alvos) {
        const bruto = await this._exec(bin, ['check', '--output-format=json', '--force-exclude', ...alvos], raiz);
        let lista;
        try {
            lista = JSON.parse(bruto.slice(bruto.indexOf('[')));
        } catch {
            return [];
        }
        return lista.map(m => ({
            ferramenta: 'ruff',
            arquivo: (m.filename || '').replace(`${raiz}/`, ''),
            linha: m.location?.row ?? 0,
            regra: m.code || 'ruff',
            severidade: 'aviso',
            mensagem: m.message
        }));
    }

    async _exec(cmd, args, cwd) {
        try {
            const { stdout } = await execFileAsync(cmd, args, {
                cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024
            });
            return stdout;
        } catch (e) {
            return `${e.stdout || ''}`;
        }
    }
}

export default new Lint();

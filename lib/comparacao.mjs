// A comparação que TODA a tela usa: o diff, as checagens, a análise e o lint.
//
// Existe porque cada um resolvia a sua base e eles discordavam. O caso que expôs isso: num chamado
// inteiro mesclado, a PR do GitHub mostrava 2, 4, 27 e 65 arquivos e a tela mostrava 0 em todos.
// A causa é topologia: depois do merge, `merge-base(branch, origin/stage)` É a ponta da branch, então
// o diff sai vazio por construção. A PR não adivinha — ela tem a base gravada.
//
// Regra: quando existe PR, vale a comparação DELA (baseRefOid…headRefOid). Sem PR, vale o local:
// branch local contra a base por topologia.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Diff, WORKSPACE } from './diff.mjs';

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));
const ARQUIVO = join(RAIZ, 'bases-pr.json');

export class Comparacao {
    constructor() {
        this.cache = this._ler();
    }

    _ler() {
        try {
            return JSON.parse(readFileSync(ARQUIVO, 'utf8'));
        } catch {
            return {};
        }
    }

    _chave(projeto, ref) {
        return `${projeto}|${ref || ''}`;
    }

    // Gravado em disco porque o `gh` leva segundos e o diff é desenhado no passo instantâneo: sem o
    // cache, a primeira abertura de cada repo mostraria a comparação errada até a rede responder.
    // Devolve se a comparação MUDOU: quem chama invalida o cache só nesse caso, senão cada leitura
    // do passo remoto derrubaria o cache que ela mesma acabou de povoar.
    guardar(projeto, ref, pr) {
        if (!pr?.baseRefOid || !pr?.headRefOid) {
            return false;
        }
        const chave = this._chave(projeto, ref);
        const antes = this.cache[chave];
        const mudou = antes?.base !== pr.baseRefOid || antes?.head !== pr.headRefOid;
        this.cache[chave] = {
            base: pr.baseRefOid, head: pr.headRefOid,
            numero: pr.number, estado: pr.state, destino: pr.baseRefName
        };
        try {
            writeFileSync(ARQUIVO, `${JSON.stringify(this.cache, null, 2)}\n`);
        } catch {
            // cache em disco é conveniência: sem ele a tela continua correta, só mais lenta
        }
        return mudou;
    }

    resolver(projeto, ref = '', baseForcada = null) {
        const d = new Diff(projeto, ref);
        if (baseForcada && baseForcada !== '-') {
            return { diff: d, base: d.resolverBase(baseForcada), alvo: ref, via: 'informada' };
        }
        const pr = this.cache[this._chave(projeto, ref)];
        if (pr && this._temCommits(projeto, pr)) {
            const base = this._mergeBase(projeto, pr.base, pr.head);
            if (base) {
                const dp = new Diff(projeto, pr.head);
                dp.baseNome = `PR #${pr.numero} → ${pr.destino}`;
                dp.mesclado = pr.estado === 'MERGED';
                dp.comoSoube = 'pr';
                return { diff: dp, base, alvo: pr.head, via: 'pr', pr };
            }
        }
        return { diff: d, base: d.resolverBase(), alvo: ref, via: 'local' };
    }

    _raiz(projeto) {
        return projeto.startsWith('/') ? projeto : join(WORKSPACE, projeto);
    }

    _temCommits(projeto, pr) {
        return [pr.base, pr.head].every(oid => {
            try {
                execFileSync('git', ['-C', this._raiz(projeto), 'cat-file', '-e', oid], { stdio: 'ignore' });
                return true;
            } catch {
                return false;
            }
        });
    }

    _mergeBase(projeto, a, b) {
        try {
            return execFileSync('git', ['-C', this._raiz(projeto), 'merge-base', a, b],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
        } catch {
            return null;
        }
    }
}

export default new Comparacao();

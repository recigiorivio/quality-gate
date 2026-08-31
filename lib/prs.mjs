// Só os PRs do chamado, para a barra. O `contexto.mjs` leva 17 s porque faz 3 chamadas ao `gh` por
// repo (base observada, PR, checks) em sequência; aqui é uma por repo, todas em paralelo.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { WORKSPACE } from './diff.mjs';

const execFileAsync = promisify(execFile);
const ROTULO = { OPEN: 'aberta', MERGED: 'mesclada', CLOSED: 'fechada' };

export class Prs {
    async doChamado(chamado, projetos) {
        const resultados = await Promise.all(projetos.map(p => this._doRepo(chamado, p)));
        return resultados.filter(Boolean);
    }

    async _doRepo(chamado, projeto) {
        try {
            const { stdout } = await execFileAsync('gh',
                ['pr', 'list', '--head', chamado, '--state', 'all', '--json', 'number,state,url,isDraft,title'],
                { cwd: join(WORKSPACE, projeto), encoding: 'utf8', timeout: 30000 });
            const pr = JSON.parse(stdout)[0];
            if (!pr) {
                return { projeto, temPr: false };
            }
            return {
                projeto,
                temPr: true,
                numero: pr.number,
                estado: pr.state,
                rotulo: (ROTULO[pr.state] || pr.state.toLowerCase()) + (pr.isDraft ? ' · draft' : ''),
                url: pr.url,
                titulo: pr.title
            };
        } catch {
            // Sem gh, sem rede ou repo sem remote: a barra diz que não sabe, não que não existe.
            return { projeto, temPr: null };
        }
    }
}

export default new Prs();

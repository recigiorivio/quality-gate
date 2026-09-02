// Só os PRs do chamado, para a barra. O `contexto.mjs` leva 17 s porque faz 3 chamadas ao `gh` por
// repo (base observada, PR, checks) em sequência; aqui é uma por repo, todas em paralelo.

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE } from './diff.mjs';
import linear from './linear.mjs';

const execFileAsync = promisify(execFile);
const ROTULO = { OPEN: 'aberta', MERGED: 'mesclada', CLOSED: 'fechada' };

export class Prs {
    // Três fontes, porque nenhuma sozinha basta:
    //  - a branch local acha o PR do repo clonado cuja branch é exatamente o ID
    //  - a busca na org acha repo NÃO clonado e branch com sufixo (`UND-1638-hml`)
    //  - o LINEAR é a fonte autoritativa de "quais PRs são deste chamado": num caso real trouxe 25
    //    contra 10 das outras duas juntas, incluindo repos que não existem neste workspace. É cache
    //    gravado pelo agente, então vem com data e a tela mostra a data.
    async doChamado(chamado, projetos) {
        const [locais, naOrg] = await Promise.all([
            Promise.all(projetos.map(p => this._doRepo(chamado, p))),
            this.naOrg(chamado)
        ]);
        const lista = locais.filter(Boolean);
        // Dedup pela URL do PR, que é inequívoca. Nome de pasta não serve (os forks renomearam o
        // remote) e nome do remote também não: o `jungle-monorepo` aponta para `jungle-services`, mas
        // o `gh` resolve o PR no repo PAI do fork (`rivio-hub`), então as duas chaves discordavam.
        const jaTem = new Set(lista.filter(x => x.url).map(x => x.url));
        for (const p of naOrg) {
            if (jaTem.has(p.url)) {
                continue;
            }
            jaTem.add(p.url);
            lista.push({ ...p, foraDaVarredura: true, clonado: false });
        }
        const doLinear = linear.doChamado(chamado);
        for (const p of doLinear?.prs || []) {
            if (!p.url || jaTem.has(p.url)) {
                continue;
            }
            jaTem.add(p.url);
            const m = p.url.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/);
            lista.push({
                projeto: m ? m[1] : '(repo)',
                temPr: true,
                numero: m ? Number(m[2]) : null,
                // O Linear não guarda o estado do PR, só o link. Dizer "aberta" seria inventar.
                estado: 'DESCONHECIDO',
                rotulo: 'estado não sabido',
                url: p.url,
                titulo: p.titulo,
                doLinear: true
            });
        }
        // Aberto primeiro, fechado por último: um PR fechado do chamado é informação, não prioridade.
        const peso = { OPEN: 0, MERGED: 1, CLOSED: 2, DESCONHECIDO: 3 };
        return lista.sort((a, b) => (peso[a.estado] ?? 4) - (peso[b.estado] ?? 4));
    }

    // `gh search prs` casa o texto em qualquer lugar, inclusive o NÚMERO do PR — a busca por
    // "UND-1638" devolvia um PR #1638 de outro chamado. Por isso exige o ID como palavra no título.
    async naOrg(chamado) {
        const org = this._org();
        if (!org) {
            return [];
        }
        try {
            const { stdout } = await execFileAsync('gh',
                ['search', 'prs', chamado, '--owner', org, '--limit', '50',
                    '--json', 'repository,number,state,title,url,isDraft'],
                { encoding: 'utf8', timeout: 30000 });
            const alvo = new RegExp(`\\b${chamado}\\b`, 'i');
            return JSON.parse(stdout)
                .filter(p => alvo.test(p.title))
                .map(p => ({
                    projeto: p.repository.name,
                    temPr: true,
                    numero: p.number,
                    estado: (p.state || '').toUpperCase(),
                    rotulo: (ROTULO[(p.state || '').toUpperCase()] || p.state) + (p.isDraft ? ' · draft' : ''),
                    url: p.url,
                    titulo: p.title
                }));
        } catch {
            return [];
        }
    }

    // O nome no GitHub pode diferir do nome da pasta — os forks renomearam o remote.
    _repoGithub(projeto) {
        try {
            const url = execFileSync('git', ['-C', join(WORKSPACE, projeto), 'remote', 'get-url', 'origin'],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
            return (url.match(/\/([^/]+?)(\.git)?$/) || [])[1] || projeto;
        } catch {
            return projeto;
        }
    }

    // A org sai do remote de um repo, não de constante: o projeto não é deste workspace.
    _org() {
        for (const candidato of readdirSync(WORKSPACE, { withFileTypes: true })) {
            if (!candidato.isDirectory()) {
                continue;
            }
            try {
                const url = execFileSync('git', ['-C', join(WORKSPACE, candidato.name), 'remote', 'get-url', 'origin'],
                    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
                const m = url.match(/[:/]([^/:]+)\/[^/]+?(\.git)?$/);
                if (m) {
                    return m[1];
                }
            } catch {
                continue;
            }
        }
        return null;
    }

    async _doRepo(chamado, projeto) {
        try {
            const { stdout } = await execFileAsync('gh',
                ['pr', 'list', '--head', chamado, '--state', 'all', '--json', 'number,state,url,isDraft,title'],
                { cwd: join(WORKSPACE, projeto), encoding: 'utf8', timeout: 30000 });
            const pr = JSON.parse(stdout)[0];
            const repoGithub = this._repoGithub(projeto);
            if (!pr) {
                return { projeto, repoGithub, temPr: false };
            }
            return {
                projeto,
                repoGithub,
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

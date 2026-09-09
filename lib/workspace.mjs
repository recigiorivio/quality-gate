// Descobre os chamados abertos no workspace: um chamado é uma branch no padrão do ID em N repos.
// Num workspace de projetos independentes, o repo esquecido é o erro caro — e ele só aparece
// olhando os 51 de uma vez.
//
// A varredura custava 7 s e travava o servidor inteiro: eram ~509 `execFileSync` em série (um
// `log -1` por branch de chamado, em cada repo), e sync no caminho da requisição para o event loop
// inteiro — um `/favicon.svg` pedido no meio esperava 7 s. Medido: 7.052 ms.
//
// Agora é UMA chamada por repo, assíncrona e em paralelo: o `for-each-ref` devolve nome, data,
// assunto e o marcador de checkout de todas as branches de uma vez. Medido: 137 ms nos mesmos
// 51 repos. O `status --porcelain` sobrou, e só nos repos parados numa branch de chamado.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE } from './diff.mjs';

const execFileAsync = promisify(execFile);
const PADRAO_CHAMADO = /^[A-Z]{2,5}-\d+$/;
// `\x01` como separador porque assunto de commit contém `|`, `\t` e quase tudo o mais.
const CAMPOS = '%(HEAD)\x01%(refname:short)\x01%(committerdate:iso-strict)\x01%(subject)';

export class Workspace {
    async git(projeto, ...args) {
        try {
            const { stdout } = await execFileAsync('git', ['-C', join(WORKSPACE, projeto), ...args], {
                encoding: 'utf8', maxBuffer: 16 * 1024 * 1024
            });
            return stdout.trim();
        } catch {
            return null;
        }
    }

    repos() {
        return readdirSync(WORKSPACE, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.name.startsWith('.') && existsSync(join(WORKSPACE, d.name, '.git')))
            .map(d => d.name);
    }

    // Descobre pelas branches que EXISTEM (local e origin), não pela que está em checkout: repo com
    // a branch do chamado mas parado em outro trabalho é justamente o repo esquecido, e some se o
    // critério for o HEAD. Medido num chamado real: 7 repos tinham a branch e 5 estavam nela.
    async chamados() {
        const lidos = await Promise.all(this.repos().map(p => this._lerRepo(p)));
        const porChamado = new Map();
        // O `sujo` é uma segunda leva porque só interessa em repo parado numa branch de chamado —
        // são poucos, e pedir `status` nos 51 devolveria a série que acabou de sair daqui.
        const sujos = new Map(await Promise.all(lidos
            .filter(r => r && r.achadas.has(r.branchAtual))
            .map(async r => [r.projeto, await this._sujo(r.projeto)])));
        for (const repo of lidos.filter(Boolean)) {
            for (const [chamado, achada] of repo.achadas) {
                const naBranch = repo.branchAtual === chamado;
                if (!porChamado.has(chamado)) {
                    porChamado.set(chamado, { chamado, repos: [], ultimaData: '' });
                }
                const item = porChamado.get(chamado);
                item.repos.push({
                    projeto: repo.projeto,
                    naBranch,
                    ref: naBranch ? '' : achada.ref,
                    branchAtual: repo.branchAtual,
                    sujo: naBranch ? (sujos.get(repo.projeto) || 0) : 0,
                    ultimoCommit: achada.assunto,
                    data: achada.data
                });
                if (achada.data > item.ultimaData) {
                    item.ultimaData = achada.data;
                }
            }
        }
        for (const item of porChamado.values()) {
            // Quem está na branch primeiro: é onde o trabalho está acontecendo agora.
            item.repos.sort((a, b) => (b.naBranch - a.naBranch) || a.projeto.localeCompare(b.projeto));
        }
        // Aberto = alguém está parado nele em algum repo. Sem esse corte vinham 190 chamados, quase
        // todos branch antiga nunca apagada — e o repo esquecido some no meio do ruído.
        return [...porChamado.values()]
            .filter(c => c.repos.some(r => r.naBranch))
            .sort((a, b) => b.ultimaData.localeCompare(a.ultimaData));
    }

    // Uma chamada, quatro campos. `%(HEAD)` marca com `*` a branch em checkout, e é assim que o
    // `branchAtual` sai daqui sem um `rev-parse` à parte. HEAD solto não marca nada — igual ao
    // comportamento antigo, em que `rev-parse --abbrev-ref` devolvia `HEAD` e não casava com nada.
    async _lerRepo(projeto) {
        const saida = await this.git(projeto, 'for-each-ref', `--format=${CAMPOS}`,
            'refs/heads', 'refs/remotes/origin');
        if (saida === null) {
            return null;
        }
        const achadas = new Map();
        let branchAtual = 'HEAD';
        for (const linha of saida.split('\n')) {
            const [marca, refname, data, ...resto] = linha.split('\x01');
            if (!refname) {
                continue;
            }
            const limpo = refname.replace(/^origin\//, '');
            if (marca === '*') {
                branchAtual = refname;
            }
            if (!PADRAO_CHAMADO.test(limpo)) {
                continue;
            }
            // Prefere a branch local; sem ela, o ref do origin é o que tem o trabalho.
            const ehLocal = !refname.startsWith('origin/');
            const anterior = achadas.get(limpo);
            if (!anterior || (ehLocal && !anterior.local)) {
                achadas.set(limpo, { local: ehLocal, ref: refname, data: data || '', assunto: resto.join('\x01') || '' });
            }
        }
        return { projeto, branchAtual, achadas };
    }

    async _sujo(projeto) {
        const saida = await this.git(projeto, 'status', '--porcelain');
        return (saida || '').split('\n').filter(Boolean).length;
    }
}

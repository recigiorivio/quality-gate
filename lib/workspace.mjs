// Descobre os chamados abertos no workspace: um chamado é uma branch no padrão do ID em N repos.
// Num workspace de projetos independentes, o repo esquecido é o erro caro — e ele só aparece
// olhando os 49 de uma vez.

import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE } from './diff.mjs';

const PADRAO_CHAMADO = /^[A-Z]{2,5}-\d+$/;

export class Workspace {
    git(projeto, ...args) {
        try {
            return execFileSync('git', ['-C', join(WORKSPACE, projeto), ...args], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            }).trim();
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
    // critério for o HEAD. Medido no UND-1638: 7 repos têm a branch, 5 estavam nela.
    chamados() {
        const porChamado = new Map();
        for (const projeto of this.repos()) {
            const atual = this.git(projeto, 'rev-parse', '--abbrev-ref', 'HEAD');
            const brutas = this.git(projeto, 'branch', '-a', '--format=%(refname:short)') || '';
            const achadas = new Map();
            for (const nome of brutas.split('\n')) {
                const limpo = nome.trim().replace(/^origin\//, '');
                if (!PADRAO_CHAMADO.test(limpo)) {
                    continue;
                }
                // Prefere a branch local; sem ela, o ref do origin é o que tem o trabalho.
                const ehLocal = !nome.startsWith('origin/');
                const anterior = achadas.get(limpo);
                if (!anterior || (ehLocal && !anterior.local)) {
                    achadas.set(limpo, { local: ehLocal, ref: nome.trim() });
                }
            }
            for (const [chamado, { ref }] of achadas) {
                const naBranch = atual === chamado;
                const sujo = naBranch
                    ? (this.git(projeto, 'status', '--porcelain') || '').split('\n').filter(Boolean).length
                    : 0;
                const ultimo = this.git(projeto, 'log', '-1', '--format=%cI|%s', ref);
                const [data, assunto] = (ultimo || '|').split('|');
                if (!porChamado.has(chamado)) {
                    porChamado.set(chamado, { chamado, repos: [], ultimaData: '' });
                }
                const item = porChamado.get(chamado);
                item.repos.push({
                    projeto,
                    naBranch,
                    ref: naBranch ? '' : ref,
                    branchAtual: atual,
                    sujo,
                    ultimoCommit: assunto || '',
                    data: data || ''
                });
                if ((data || '') > item.ultimaData) {
                    item.ultimaData = data || '';
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
}

// Estado do chamado atravessando o workspace: quais repos estão na branch, o que foi enviado,
// se tem PR, se o build passou. Num workspace de projetos independentes, o erro caro é o repo
// esquecido — e ele não aparece olhando um projeto só.
//
// uso: node qualidade/ferramentas/contexto.mjs [ID-DO-CHAMADO] [--json]

import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE } from '../lib/diff.mjs';

const RAIZ_PROJETO = dirname(dirname(fileURLToPath(import.meta.url)));

const PADRAO_CHAMADO = /^[A-Z]{2,5}-\d+$/;
// A base de cada repo é OBSERVADA (para onde os PRs recentes mesclaram). Este mapa é só a queda
// quando não há PR mesclado para consultar, e vive num arquivo porque é do seu time, não do projeto:
// `bases.json` no formato { "nome-do-repo": "branch-base" }.
const BASE_PADRAO = process.env.QUALIDADE_BASE_PADRAO || 'main';
const BASE_POR_PROJETO = (() => {
    try {
        return JSON.parse(readFileSync(join(RAIZ_PROJETO, 'bases.json'), 'utf8'));
    } catch {
        return {};
    }
})();

class Contexto {
    constructor(chamado) {
        this.chamado = chamado;
    }

    cmd(exec, args, cwd) {
        try {
            return execFileSync(exec, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        } catch {
            return null;
        }
    }

    git(projeto, ...args) {
        return this.cmd('git', args, join(WORKSPACE, projeto));
    }

    listarRepos() {
        return readdirSync(WORKSPACE, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.name.startsWith('.') && existsSync(join(WORKSPACE, d.name, '.git')))
            .map(d => d.name);
    }

    // A base varia por projeto e não deve ser presumida: vale para onde os PRs recentes mesclaram.
    // O mapa fixo é só a queda quando não há PR mesclado para consultar.
    baseDe(projeto) {
        const bruto = this.cmd('gh', ['pr', 'list', '--state', 'merged', '--limit', '8',
            '--json', 'baseRefName'], join(WORKSPACE, projeto));
        try {
            const lista = bruto ? JSON.parse(bruto) : [];
            if (lista.length) {
                const contagem = {};
                for (const { baseRefName } of lista) {
                    contagem[baseRefName] = (contagem[baseRefName] || 0) + 1;
                }
                const ordenada = Object.entries(contagem).sort((a, b) => b[1] - a[1]);
                const [vencedora, n] = ordenada[0];
                const distribuicao = ordenada.map(([b, c]) => `${b}:${c}`).join(' ');
                // Sem maioria clara não se afirma base — dizer "dividido" é mais útil que chutar.
                return {
                    nome: vencedora,
                    origem: `${n}/${lista.length} PRs mesclados`,
                    ambigua: n / lista.length < 0.6,
                    distribuicao
                };
            }
        } catch {
            // sem gh ou sem PR: cai no mapa
        }
        const preferida = BASE_POR_PROJETO[projeto] || BASE_PADRAO;
        for (const b of [preferida, BASE_PADRAO, 'stage', 'main', 'master']) {
            if (this.git(projeto, 'rev-parse', '--verify', `origin/${b}`)) {
                return { nome: b, origem: 'presumida — sem PR mesclado para conferir' };
            }
        }
        return null;
    }

    // Descobre o chamado pelas branches: só entra no relatório repo que está na branch dele.
    // Filtrar por "tem arquivo sujo" trazia os 49 repos do workspace e afogava o sinal.
    descobrirChamado() {
        if (this.chamado) {
            return this.chamado.toUpperCase();
        }
        const encontrados = new Set();
        for (const projeto of this.listarRepos()) {
            const branch = this.git(projeto, 'rev-parse', '--abbrev-ref', 'HEAD');
            if (branch && PADRAO_CHAMADO.test(branch)) {
                encontrados.add(branch);
            }
        }
        if (encontrados.size === 1) {
            return [...encontrados][0];
        }
        this.ambiguo = [...encontrados];
        return null;
    }

    // Aceita repo que TEM a branch, mesmo parado em outro checkout — é o repo esquecido, e exigir
    // HEAD == chamado o escondia junto com o PR dele (deu "sem PR" num PR aberto).
    inspecionar(projeto, chamado) {
        const atual = this.git(projeto, 'rev-parse', '--abbrev-ref', 'HEAD');
        const temLocal = this.git(projeto, 'rev-parse', '--verify', chamado);
        const temRemoto = this.git(projeto, 'rev-parse', '--verify', `origin/${chamado}`);
        if (!temLocal && !temRemoto) {
            return null;
        }
        const naBranch = atual === chamado;
        const ref = temLocal ? chamado : `origin/${chamado}`;
        const branch = chamado;
        const sujo = naBranch
            ? (this.git(projeto, 'status', '--porcelain') || '').split('\n').filter(Boolean).length
            : 0;
        const base = this.baseDe(projeto);
        const nomeBase = base ? base.nome : null;
        const naoEnviados = temLocal && temRemoto
            ? Number(this.git(projeto, 'rev-list', '--count', `origin/${branch}..${branch}`) || 0)
            : 0;
        const commits = nomeBase ? Number(this.git(projeto, 'rev-list', '--count', `origin/${nomeBase}..${ref}`) || 0) : 0;

        const prBruto = this.cmd('gh', ['pr', 'list', '--head', branch, '--state', 'all',
            '--json', 'number,url,state,baseRefName,isDraft,mergedAt,mergeCommit'], join(WORKSPACE, projeto));
        let pr = null;
        try {
            pr = prBruto ? (JSON.parse(prBruto)[0] || null) : null;
        } catch {
            pr = null;
        }
        let checks = null;
        if (pr) {
            const bruto = this.cmd('gh', ['pr', 'checks', String(pr.number), '--json', 'name,state'], join(WORKSPACE, projeto));
            try {
                const lista = bruto ? JSON.parse(bruto) : [];
                checks = {
                    total: lista.length,
                    falhando: lista.filter(c => /FAIL|ERROR|CANCEL/i.test(c.state)).map(c => c.name),
                    pendentes: lista.filter(c => /PENDING|QUEUED|IN_PROGRESS/i.test(c.state)).length,
                    pulados: lista.filter(c => /SKIP|NEUTRAL/i.test(c.state)).map(c => c.name),
                    passando: lista.filter(c => /SUCCESS|PASS/i.test(c.state)).map(c => c.name)
                };
            } catch {
                checks = null;
            }
        }
        return {
            projeto, branch, base, sujo, naoEnviados, commits, pr, checks,
            naBranch, branchAtual: atual, ref: naBranch ? '' : ref,
            nomeOk: PADRAO_CHAMADO.test(branch)
        };
    }

    relatar() {
        const linhas = [];
        const chamado = this.descobrirChamado();
        if (!chamado) {
            const achados = this.ambiguo || [];
            return achados.length
                ? `Mais de um chamado aberto no workspace: ${achados.join(', ')}\nRode com o ID: node contexto.mjs ${achados[0]}`
                : 'Nenhuma branch no padrão ID do chamado (ex: ABC-1234). Rode com o ID explícito.';
        }
        const repos = this.listarRepos().map(p => this.inspecionar(p, chamado)).filter(Boolean);
        if (!repos.length) {
            return `Nenhum repo na branch ${chamado}.`;
        }
        linhas.push(`Chamado: ${chamado}   ·   ${repos.length} repo(s) na branch\n`);

        for (const r of repos) {
            const problemas = [];
            if (!r.nomeOk) {
                problemas.push('nome da branch fora do padrão (esperado só o ID; renomear com PR aberto fecha o PR)');
            }
            if (r.sujo) {
                problemas.push(`${r.sujo} arquivo(s) não commitado(s)`);
            }
            if (r.naoEnviados) {
                problemas.push(`${r.naoEnviados} commit(s) não enviado(s)`);
            }
            if (!r.pr && r.commits) {
                problemas.push('sem PR aberto');
            }
            if (r.pr && r.base && r.base.ambigua) {
                problemas.push(`base sem consenso no histórico (${r.base.distribuicao}) — PR está em ${r.pr.baseRefName}; confirmar`);
            } else if (r.pr && r.base && r.pr.baseRefName !== r.base.nome) {
                problemas.push(`PR aponta para ${r.pr.baseRefName}, base observada é ${r.base.nome} (${r.base.origem})`);
            }
            if (r.pr && r.pr.isDraft) {
                problemas.push('PR em draft');
            }
            if (r.checks && r.checks.falhando.length) {
                problemas.push(`build falhando: ${r.checks.falhando.join(', ')}`);
            }
            if (r.checks && r.checks.pendentes) {
                problemas.push(`${r.checks.pendentes} check(s) em execução — build não confirmado`);
            }
            // Build pulado não é build passando: é a falha silenciosa, não a ausência de falha.
            if (r.checks && r.checks.pulados.length) {
                problemas.push(`build PULADO (não passou, não rodou): ${r.checks.pulados.join(', ')}`);
            }
            if (r.pr && r.checks && !r.checks.total) {
                problemas.push('PR sem nenhum check — não há build para confirmar');
            }

            const marca = problemas.length ? '!' : '✓';
            linhas.push(`${marca} ${r.projeto}`);
            linhas.push(`    branch ${r.branch} → ${r.base ? r.base.nome : '?'}   ${r.commits} commit(s) na branch`
                + (r.naBranch ? '' : `   [não está em checkout — HEAD em ${r.branchAtual}]`));
            if (r.checks) {
                linhas.push(`    checks: ${r.checks.passando.length} ok, ${r.checks.pulados.length} pulado(s), ${r.checks.falhando.length} falhando, ${r.checks.pendentes} rodando`);
            }
            linhas.push(`    PR: ${r.pr ? `#${r.pr.number} ${r.pr.state} ${r.pr.url}` : 'nenhum'}`);
            for (const p of problemas) {
                linhas.push(`    ↳ ${p}`);
            }
            linhas.push('');
        }
        const semPr = repos.filter(r => !r.pr && r.commits).map(r => r.projeto);
        if (semPr.length) {
            linhas.push(`Falta PR em: ${semPr.join(', ')}`);
        }
        linhas.push('Lembrete: UM PR por projeto por chamado; comentário no Linear fecha o loop.');
        return linhas.join('\n');
    }
}

const argumentos = process.argv.slice(2);
const contexto = new Contexto(argumentos.find(a => !a.startsWith('--')));
if (argumentos.includes('--json')) {
    const chamado = contexto.descobrirChamado();
    const filtro = (argumentos.find(a => a.startsWith('--projeto=')) || '').split('=')[1];
    const alvos = chamado ? contexto.listarRepos().filter(p => !filtro || p === filtro) : [];
    const repos = alvos.map(p => contexto.inspecionar(p, chamado)).filter(Boolean);
    process.stdout.write(JSON.stringify({ chamado, ambiguo: contexto.ambiguo || null, repos }));
} else {
    console.log(contexto.relatar());
}

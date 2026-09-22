// O que está buildando agora no GitHub Actions, nos repos do catálogo da implantação.
// `resumo()` é uma chamada ao `gh` por repo; `detalhe()` abre os jobs e só sai quando a modal pede.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { WORKSPACE } from './diff.mjs';

const execFileAsync = promisify(execFile);

export class Builds {
    constructor() {
        this.porRepo = 15;
        this.segundos = 20;
        this.janelaConcluidas = 5 * 60 * 1000;
        this.etags = new Map();
    }

    async resumo(projetos) {
        const achados = await Promise.all(projetos.map(p => this._doRepo(p)));
        const semResposta = achados.filter(a => a.erro).map(a => ({ projeto: a.projeto, erro: a.erro }));
        const runs = achados.flatMap(a => a.runs || [])
            .sort((a, b) => String(a.inicio).localeCompare(String(b.inicio)));
        const concluidas = achados.flatMap(a => a.concluidas || [])
            .sort((a, b) => String(b.fim).localeCompare(String(a.fim)));
        return {
            repos: projetos.length,
            buildando: [...new Set(runs.map(r => r.projeto))],
            total: runs.length,
            rodando: runs.filter(r => r.status === 'in_progress').length,
            runs,
            concluidas,
            semResposta
        };
    }

    async detalhe(projetos) {
        const r = await this.resumo(projetos);
        r.runs = await Promise.all(r.runs.map(async run => ({ ...run, jobs: await this._jobs(run) })));
        return r;
    }

    async _doRepo(projeto) {
        const slug = await this._slug(projeto);
        if (!slug) {
            return { projeto, erro: 'sem remote origin no GitHub' };
        }
        const dados = await this._gh(`repos/${slug}/actions/runs?per_page=${this.porRepo}`);
        if (dados.erro) {
            return { projeto, erro: dados.erro };
        }
        const todas = dados.workflow_runs || [];
        const desde = Date.now() - this.janelaConcluidas;
        const concluidas = todas
            .filter(w => w.status === 'completed' && Date.parse(w.updated_at) >= desde)
            .map(w => ({ ...this._run(projeto, slug, w), conclusao: w.conclusion, fim: w.updated_at }));
        const runs = todas.filter(w => w.status !== 'completed').map(w => this._run(projeto, slug, w));
        return { projeto, runs, concluidas };
    }

    _run(projeto, slug, w) {
        return {
            projeto,
            slug,
            id: w.id,
            workflow: w.name,
            titulo: w.display_title,
            branch: w.head_branch,
            evento: w.event,
            autor: w.actor?.login || null,
            status: w.status,
            inicio: w.run_started_at || w.created_at,
            url: w.html_url
        };
    }

    // Só o job ativo diz o passo; job concluído entra na conta de "3 de 5" e não na lista.
    async _jobs(run) {
        const dados = await this._gh(`repos/${run.slug}/actions/runs/${run.id}/jobs?per_page=50`);
        if (dados.erro) {
            return null;
        }
        return (dados.jobs || []).map(j => {
            const passos = j.steps || [];
            const atual = passos.find(s => s.status === 'in_progress')
                || passos.find(s => s.status === 'queued');
            return {
                nome: j.name,
                status: j.status,
                conclusao: j.conclusion,
                inicio: j.started_at,
                passo: atual?.name || null,
                passoNumero: atual ? passos.indexOf(atual) + 1 : null,
                passos: passos.length
            };
        });
    }

    async _slug(projeto) {
        try {
            const { stdout } = await execFileAsync('git',
                ['-C', join(WORKSPACE, projeto), 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
            return this._slugDe(stdout.trim());
        } catch {
            return null;
        }
    }

    _slugDe(url) {
        const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/);
        return m ? `${m[1]}/${m[2]}` : null;
    }

    // Pedido condicional: o 304 não consome o limite de 5.000/h do GitHub, e a sondagem é de 30 s.
    async _gh(caminho) {
        const guardado = this.etags.get(caminho);
        const args = ['api', '-i', caminho, ...(guardado ? ['-H', `If-None-Match: ${guardado.etag}`] : [])];
        let saida;
        try {
            ({ stdout: saida } = await execFileAsync('gh', args,
                { encoding: 'utf8', timeout: this.segundos * 1000, maxBuffer: 8 * 1024 * 1024 }));
        } catch (e) {
            if (guardado && /^HTTP\/\S+ 304/.test(e.stdout || '')) {
                return guardado.dados;
            }
            const erro = `${e.stderr || ''}`.trim().split('\n')[0];
            return { erro: (erro || e.message).slice(0, 120) };
        }
        const fim = saida.search(/\r?\n\r?\n/);
        const cabecalho = saida.slice(0, fim);
        const dados = JSON.parse(saida.slice(fim).trim());
        const etag = cabecalho.match(/^etag:\s*(.+?)\s*$/im)?.[1];
        if (etag) {
            this.etags.set(caminho, { etag, dados });
        }
        return dados;
    }
}

export default new Builds();

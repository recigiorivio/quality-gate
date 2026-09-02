// A comparação que TODA a tela usa: o diff, as checagens, a análise e o lint.
//
// **Quem decide é o agente, não a ferramenta.** A tentativa de automatizar falhou por um motivo
// concreto: num chamado real havia 22 branches em 12 repos e, num único repo, 7 PRs em 7 branches —
// seis mescladas e a aberta sendo outra. Topologia adivinhava e errava (mostrava 0 arquivo onde a PR
// mostrava 27), e escolher "a PR da branch com o nome do chamado" pegava a PR mesclada errada.
//
// Então a rotina de fim de trabalho grava a decisão em `comparacoes.json`, e aqui só se obedece.
// Sem decisão, cai no local (branch × base por topologia) e a tela DIZ que ninguém decidiu — porque
// o palpite não anunciado foi o que criou o problema.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Diff, WORKSPACE } from './diff.mjs';

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));
export const ARQUIVO = join(RAIZ, 'comparacoes.json');

export class Comparacao {
    constructor(arquivo = ARQUIVO) {
        this.arquivo = arquivo;
        this.decisoes = this._ler();
    }

    _ler() {
        try {
            return JSON.parse(readFileSync(this.arquivo, 'utf8'));
        } catch {
            return {};
        }
    }

    _chave(chamado, projeto) {
        return `${chamado || '?'}|${projeto}`;
    }

    _raiz(projeto) {
        return projeto.startsWith('/') ? projeto : join(WORKSPACE, projeto);
    }

    listar(chamado = null) {
        return Object.entries(this.decisoes)
            .filter(([k]) => !chamado || k.startsWith(`${chamado}|`))
            .map(([k, v]) => ({ chamado: k.split('|')[0], projeto: k.split('|')[1], ...v }));
    }

    definir(chamado, projeto, decisao) {
        this.decisoes[this._chave(chamado, projeto)] = { ...decisao, em: new Date().toISOString() };
        this._gravar();
        return this.decisoes[this._chave(chamado, projeto)];
    }

    remover(chamado, projeto) {
        const havia = delete this.decisoes[this._chave(chamado, projeto)];
        this._gravar();
        return havia;
    }

    _gravar() {
        writeFileSync(this.arquivo, `${JSON.stringify(this.decisoes, null, 2)}\n`);
    }

    // Devolve `{ diff, base, alvo, via, decisao }`. `via` é o que a tela mostra: `pr` e `branch` são
    // decisão do agente; `local` é palpite declarado; `informada` é base passada na URL.
    resolver(projeto, ref = '', baseForcada = null, chamado = null) {
        if (baseForcada && baseForcada !== '-') {
            const d = new Diff(projeto, ref);
            return { diff: d, base: d.resolverBase(baseForcada), alvo: ref, via: 'informada' };
        }
        const decidida = this._pelaDecisao(projeto, chamado);
        if (decidida) {
            return decidida;
        }
        const d = new Diff(projeto, ref);
        return { diff: d, base: d.resolverBase(), alvo: ref, via: 'local' };
    }

    // Três fontes possíveis, e é o agente que diz qual vale: a comparação da PR (base…head gravados
    // por ela), a branch contra o destino (`stage`), ou uma branch/base explícitas. `situacao` é o
    // veredito dele sobre o repo — resolvido ou aberto — e não é recalculado aqui.
    _pelaDecisao(projeto, chamado) {
        const dec = this.decisoes[this._chave(chamado, projeto)];
        if (!dec) {
            return null;
        }
        const alvo = dec.head || dec.branch;
        if (!alvo || !this._existe(projeto, alvo)) {
            return null;
        }
        const base = dec.via === 'pr' && dec.base && dec.head
            ? this._mergeBase(projeto, dec.base, dec.head)
            : this._mergeBase(projeto, dec.base || 'origin/stage', alvo);
        if (!base) {
            return null;
        }
        const d = new Diff(projeto, alvo);
        d.baseNome = dec.via === 'pr'
            ? `PR #${dec.pr} → ${dec.destino || 'base'}`
            : `${dec.branch} → ${dec.base || 'origin/stage'}`;
        d.mesclado = dec.situacao === 'resolvido';
        d.comoSoube = 'decisao';
        return { diff: d, base, alvo, via: dec.via || 'branch', decisao: dec };
    }

    _existe(projeto, rev) {
        try {
            execFileSync('git', ['-C', this._raiz(projeto), 'rev-parse', '--verify', '-q', rev],
                { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
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

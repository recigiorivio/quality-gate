// Monta as colunas antes/depois de um arquivo alterado. Usa `git diff -U100000` para receber o
// arquivo inteiro já marcado, em vez de reimplementar um algoritmo de diff.
//
// Consumido pelo servidor (JSON) e pelo ferramentas/diff-visao.mjs (HTML estático).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// O workspace é a pasta que CONTÉM este projeto — é onde os repos vizinhos estão. `QUALIDADE_WORKSPACE`
// sobrescreve para quem quiser apontar para outro lugar. Sem isso, um caminho absoluto no código faz a
// ferramenta só funcionar na máquina de quem escreveu.
// lib/diff.mjs -> lib -> qualidade -> workspace: três níveis, não dois.
export const WORKSPACE = process.env.QUALIDADE_WORKSPACE
    || dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CONTEXTO_TOTAL = '-U100000';
const MARGEM_PADRAO = 6;
const CANDIDATAS_BASE = ['origin/desenv', 'origin/stage', 'origin/main', 'origin/master'];

export class Diff {
    // `ref` vazio = árvore de trabalho (repo parado na branch do chamado). Com ref, compara aquela
    // branch — senão o repo que está em outro checkout mostraria o diff do trabalho errado.
    constructor(projeto, ref = '') {
        this.projeto = projeto.startsWith('/') ? projeto : join(WORKSPACE, projeto);
        this.ref = ref;
    }

    git(...args) {
        return execFileSync('git', ['-C', this.projeto, ...args], {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore']
        });
    }

    branch() {
        return this.ref || this.git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    }

    _alvo() {
        return this.ref ? [this.ref] : [];
    }

    // A base não vem de ordem fixa de nomes: escolhe por topologia, o merge-base mais RECENTE entre
    // as candidatas que existem. Num repo real, `origin/desenv` existia mas não era a base dele: o
    // merge-base velho dava 17 arquivos de diff falso numa branch já mesclada em `main`, cujo
    // merge-base é 0 arquivos.
    resolverBase(base) {
        if (base && base !== '-') {
            return base;
        }
        const alvo = this.ref || 'HEAD';
        let melhor = null;
        for (const candidata of CANDIDATAS_BASE) {
            let mb;
            try {
                mb = this.git('merge-base', alvo, candidata).trim();
            } catch {
                continue;
            }
            if (!mb) {
                continue;
            }
            const quando = Number(this.git('show', '-s', '--format=%ct', mb).trim()) || 0;
            // Candidata que já CONTÉM a branch é a base de verdade: o trabalho foi mesclado nela.
            let contem = false;
            try {
                this.git('merge-base', '--is-ancestor', alvo, candidata);
                contem = true;
            } catch {
                contem = false;
            }
            const nota = (contem ? 1e12 : 0) + quando;
            if (!melhor || nota > melhor.nota) {
                melhor = { mb, nota, candidata, contem };
            }
        }
        if (!melhor) {
            return 'HEAD';
        }
        this.mesclado = melhor.contem;
        this.baseNome = melhor.candidata;
        return melhor.mb;
    }

    listarArquivos(base) {
        const nomes = this.git('diff', '--name-status', base, ...this._alvo(), '--').trim();
        if (!nomes) {
            return [];
        }
        const numeros = new Map();
        for (const linha of this.git('diff', '--numstat', base, ...this._alvo(), '--').trim().split('\n')) {
            const [mais, menos, ...resto] = linha.split('\t');
            if (resto.length) {
                numeros.set(resto[resto.length - 1], {
                    adicionadas: Number(mais) || 0,
                    removidas: Number(menos) || 0
                });
            }
        }
        return nomes.split('\n').map(l => {
            const partes = l.split('\t');
            const caminho = partes[partes.length - 1];
            return { estado: partes[0], caminho, ...(numeros.get(caminho) || { adicionadas: 0, removidas: 0 }) };
        });
    }

    // Pede ao git só a margem de contexto e sintetiza a lacuna a partir do cabeçalho do hunk.
    // Antes pedia o arquivo inteiro (-U100000) e descartava 99%: num lockfile isso eram 442 KB de
    // texto e 19 mil objetos por requisição, contra 1,6 KB agora.
    montarColunas(base, caminho, opcoes = {}) {
        const margem = opcoes.margem ?? MARGEM_PADRAO;
        let bruto;
        try {
            bruto = this.git('diff', opcoes.completo ? CONTEXTO_TOTAL : `-U${margem}`, base, ...this._alvo(), '--', caminho);
        } catch {
            return { antes: [], depois: [], adicionadas: 0, removidas: 0, total: 0, dobradas: 0 };
        }
        const antes = [];
        const depois = [];
        let adicionadas = 0;
        let removidas = 0;
        let nA = 0;
        let nD = 0;
        let fimAnterior = null;
        let dobradas = 0;
        const pendentes = [];

        const descarregar = () => {
            for (const texto of pendentes) {
                antes.push({ n: ++nA, texto, tipo: 'rem' });
                depois.push({ n: null, texto: '', tipo: 'vazio' });
            }
            pendentes.length = 0;
        };
        const lacuna = quantas => {
            dobradas += quantas;
            const marca = { n: null, texto: `⋯ ${quantas} linha${quantas > 1 ? 's' : ''} sem alteração`, tipo: 'lacuna' };
            antes.push(marca);
            depois.push({ ...marca });
        };

        for (const linha of bruto.split('\n')) {
            const cab = linha.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
            if (cab) {
                descarregar();
                const iniA = Number(cab[1]);
                const iniD = Number(cab[3]);
                const salto = fimAnterior === null ? iniA - 1 : iniA - fimAnterior - 1;
                if (salto > 0) {
                    lacuna(salto);
                }
                nA = iniA - 1;
                nD = iniD - 1;
                fimAnterior = iniA + (cab[2] === undefined ? 1 : Number(cab[2])) - 1;
                continue;
            }
            if (linha.startsWith('diff ') || linha.startsWith('index ') || linha.startsWith('--- ')
                || linha.startsWith('+++ ') || linha.startsWith('\\') || linha.startsWith('new file')
                || linha.startsWith('deleted file') || linha.startsWith('similarity')
                || linha.startsWith('rename ') || linha.startsWith('old mode') || linha.startsWith('new mode')) {
                continue;
            }
            const marca = linha[0];
            const texto = linha.slice(1);
            if (marca === '-') {
                pendentes.push(texto);
                removidas++;
            } else if (marca === '+') {
                adicionadas++;
                const parceira = pendentes.shift();
                if (parceira !== undefined) {
                    antes.push({ n: ++nA, texto: parceira, tipo: 'rem' });
                    depois.push({ n: ++nD, texto, tipo: 'add' });
                } else {
                    antes.push({ n: null, texto: '', tipo: 'vazio' });
                    depois.push({ n: ++nD, texto, tipo: 'add' });
                }
            } else if (marca === ' ') {
                descarregar();
                antes.push({ n: ++nA, texto, tipo: 'ctx' });
                depois.push({ n: ++nD, texto, tipo: 'ctx' });
            }
        }
        descarregar();
        // A sobra vem do lado DEPOIS (`nD`), que é o que o disco mede. Usar `nA` anexava uma lacuna
        // falsa do tamanho do arquivo em arquivo NOVO, onde o lado antes fica em zero.
        //
        // Arquivo APAGADO não tem lado depois: o hunk é `@@ -1,18 +0,0 @@`, então `nD` fica em -1 e o
        // fallback propagava um total negativo (o rótulo mostrava "ver arquivo inteiro (-1)"). Sem
        // arquivo no disco não há sobra a dobrar, e o total que faz sentido é a contagem do lado antes.
        const totalDoDisco = this._totalDeLinhas(caminho);
        const total = totalDoDisco || Math.max(nA, nD, 0);
        if (!opcoes.completo && totalDoDisco > 0) {
            const sobra = totalDoDisco - nD;
            if (sobra > 0) {
                lacuna(sobra);
            }
        }
        return { antes, depois, adicionadas, removidas, total, dobradas };
    }

    // Do disco, sem abrir processo: é só para o rótulo "ver arquivo inteiro (N)".
    // `split('\n')` num arquivo terminado em newline devolve uma linha vazia a mais, e todo arquivo
    // termina assim. O off-by-one virava uma lacuna falsa de 1 linha em arquivo novo, e inflava o
    // rótulo "ver arquivo inteiro (N)".
    _totalDeLinhas(caminho) {
        try {
            const texto = this.ref
                ? this.git('show', `${this.ref}:${caminho}`)
                : readFileSync(join(this.projeto, caminho), 'utf8');
            const linhas = texto.split('\n');
            if (linhas.length && linhas[linhas.length - 1] === '') {
                linhas.pop();
            }
            return linhas.length;
        } catch {
            return 0;
        }
    }

    completo(base) {
        const baseReal = this.resolverBase(base);
        const arquivos = this.listarArquivos(baseReal).map(a => ({
            ...a,
            ...this.montarColunas(baseReal, a.caminho)
        }));
        return { projeto: this.projeto, branch: this.branch(), base: baseReal, arquivos };
    }
}

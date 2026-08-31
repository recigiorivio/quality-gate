// Análise estática do diff para os dois itens que antes eram só checklist: as queries que entraram
// e o que vale extrair. Nenhuma das duas precisa de banco — o que precisa de banco é confirmar o
// plano de execução, e isso é o indices.mjs.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE } from './diff.mjs';
import ast from './ast.mjs';

const MIN_BLOCO_REPETIDO = 4;
const METODO_LONGO = 40;
// Nomes do padrão do repo: todo action tem execute, toda migration tem up/down.
const NOMES_DE_PADRAO = new Set(['execute', 'up', 'down', 'handle', 'run', 'process', 'init']);

export class Analise {
    constructor(projeto, ref = '') {
        this.projeto = projeto;
        this.ref = ref;
        this.raiz = join(WORKSPACE, projeto);
    }

    git(...args) {
        try {
            return execFileSync('git', ['-C', this.raiz, ...args], {
                encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore']
            });
        } catch {
            return '';
        }
    }

    // Uma leitura por base, reaproveitada por queries() e refatoracao(): rodava duas vezes.
    linhasAdicionadas(base) {
        if (this._cacheAdds?.base === base) {
            return this._cacheAdds.valor;
        }
        const valor = this._lerAdicionadas(base);
        this._cacheAdds = { base, valor };
        return valor;
    }

    // Só as linhas que entraram, com arquivo e número — achado em código não tocado não é desta tarefa.
    _lerAdicionadas(base) {
        const alvo = this.ref ? [base, this.ref] : [base];
        // Inclui ts/tsx/jsx de propósito: o parser vai RECUSAR esses, e é isso que se quer — arquivo
        // recusado entra em `naoLidos` e o cartão diz que não leu. Filtrar aqui fazia o cartão dizer
        // "ok" sobre arquivo que nunca chegou a ser olhado.
        const bruto = this.git('diff', '-U0', ...alvo, '--',
            '*.js', '*.mjs', '*.cjs', '*.jsx', '*.ts', '*.tsx');
        const saida = [];
        let arquivo = null;
        let n = 0;
        for (const linha of bruto.split('\n')) {
            const cab = linha.match(/^\+\+\+ b\/(.+)$/);
            if (cab) {
                arquivo = cab[1];
                continue;
            }
            const hunk = linha.match(/^@@ -\S+ \+(\d+)(?:,\d+)? @@/);
            if (hunk) {
                n = Number(hunk[1]);
                continue;
            }
            if (linha.startsWith('+') && !linha.startsWith('+++')) {
                saida.push({ arquivo, linha: n++, texto: linha.slice(1) });
            }
        }
        return saida;
    }

    // ---------- queries ----------

    // Lê por AST, não por regex. As duas versões anteriores acusaram o jeito CERTO por olharem uma
    // linha um problema que vive em várias — filtro Mongo multilinha é a forma normal de escrever.
    queries(base) {
        const adicionadas = this.linhasAdicionadas(base);
        const porArquivo = new Map();
        for (const l of adicionadas) {
            if (!porArquivo.has(l.arquivo)) {
                porArquivo.set(l.arquivo, new Set());
            }
            porArquivo.get(l.arquivo).add(l.linha);
        }
        const achadas = [];
        this.naoLidos = [];
        for (const [arquivo, novas] of porArquivo) {
            const lidas = ast.queries(this._doDisco(arquivo));
            if (lidas === null) {
                this.naoLidos.push(arquivo);
                continue;
            }
            // Só o que entrou no diff: query pré-existente não é desta tarefa.
            for (const q of lidas.filter(q => novas.has(q.linha))) {
                achadas.push({ ...q, arquivo });
            }
        }
        return achadas;
    }

    // ---------- refatoração ----------

    refatoracao(base) {
        const adicionadas = this.linhasAdicionadas(base);
        const longos = this._metodosLongos(adicionadas);
        return {
            repetidos: this._blocosRepetidos(adicionadas),
            longos,
            jaExiste: this._nomesQueJaExistem(adicionadas),
            naoLidos: this.naoLidos || []
        };
    }

    // Corrida de linhas idênticas que aparece 2× ou mais no que entrou. Ignora linha trivial
    // (fechamento, import) para não acusar `}` repetido.
    _blocosRepetidos(adicionadas) {
        const util = adicionadas.filter(l => {
            const t = l.texto.trim();
            return t.length > 12 && !/^[});\]]+$/.test(t) && !/^(import|export|const \w+ = require)/.test(t);
        });
        const janelas = new Map();
        for (let i = 0; i + MIN_BLOCO_REPETIDO <= util.length; i++) {
            const fatia = util.slice(i, i + MIN_BLOCO_REPETIDO);
            const contiguo = fatia.every((l, k) => k === 0
                || (l.arquivo === fatia[k - 1].arquivo && l.linha === fatia[k - 1].linha + 1));
            if (!contiguo) {
                continue;
            }
            const chave = fatia.map(l => l.texto.trim()).join('\n');
            if (!janelas.has(chave)) {
                janelas.set(chave, []);
            }
            janelas.get(chave).push(fatia[0]);
        }
        return [...janelas.entries()]
            .filter(([, ocorrencias]) => ocorrencias.length > 1)
            .map(([chave, ocorrencias]) => ({
                linhas: MIN_BLOCO_REPETIDO,
                vezes: ocorrencias.length,
                onde: ocorrencias.map(o => `${o.arquivo}:${o.linha}`),
                amostra: chave.split('\n')[0].slice(0, 70)
            }))
            .slice(0, 5);
    }

    // Tamanho pelo span do nó, não contando linhas até um `}` na mesma indentação — a heurística
    // antiga errava em método com objeto literal dentro.
    _metodosLongos(adicionadas) {
        const porArquivo = new Map();
        for (const l of adicionadas) {
            if (!porArquivo.has(l.arquivo)) {
                porArquivo.set(l.arquivo, new Set());
            }
            porArquivo.get(l.arquivo).add(l.linha);
        }
        const longos = [];
        this.naoLidos = [];
        for (const [arquivo, novas] of porArquivo) {
            const metodos = ast.metodos(this._doDisco(arquivo));
            if (metodos === null) {
                this.naoLidos.push(arquivo);
                continue;
            }
            for (const m of metodos) {
                // Bloco de declaração não é método longo: é lista de campos, e o padrão pede que seja.
                const tocado = [...novas].some(n => n >= m.inicio && n <= m.fim);
                if (!m.declarativo && m.tamanho > METODO_LONGO && tocado) {
                    longos.push({ arquivo, linha: m.inicio, metodo: m.nome, tamanho: m.tamanho, sentencas: m.sentencas });
                }
            }
        }
        return longos.slice(0, 6);
    }

    _doDisco(arquivo) {
        if (this.ref) {
            return this.git('show', `${this.ref}:${arquivo}`) || '';
        }
        try {
            return readFileSync(join(this.raiz, arquivo), 'utf8');
        } catch {
            return this.git('show', `HEAD:${arquivo}`) || '';
        }
    }

    // Responde "já existe?" com grep, não com memória: nome novo que aparece em outro arquivo do
    // repo é candidato a reuso, não necessariamente duplicação.
    _nomesQueJaExistem(adicionadas) {
        const novos = new Set();
        for (const l of adicionadas) {
            const m = l.texto.match(/^\s*(?:async\s+)?(?:function\s+)?([a-z_][\w$]{4,})\s*\([^)]*\)\s*\{/);
            if (m && !/^(if|for|while|switch|catch|return|constructor)$/.test(m[1]) && !NOMES_DE_PADRAO.has(m[1])) {
                novos.add(m[1]);
            }
        }
        const lista = [...novos].slice(0, 12);
        if (!lista.length) {
            return [];
        }
        // Um `git grep` com todos os nomes de uma vez, em vez de um por nome.
        const padroes = lista.flatMap(n => ['-e', `\\b${n}\\b`]);
        const bruto = this.git('grep', '-l', '-E', ...padroes, '--', '*.js', '*.mjs');
        const candidatos = bruto.split('\n').filter(Boolean);
        const achados = [];
        for (const nome of lista) {
            const re = new RegExp(`\\b${nome}\\b`);
            // Spec citando o nome não é reuso — é o teste do próprio código novo.
            const onde = candidatos.filter(a => !adicionadas.some(l => l.arquivo === a)
                && !/\.spec\.js$|^spec\//.test(a)
                && re.test(this._doDisco(a)));
            if (onde.length) {
                achados.push({ nome, arquivos: onde.slice(0, 3), total: onde.length });
            }
        }
        return achados.slice(0, 6);
    }
}

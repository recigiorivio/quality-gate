// Checagens mecânicas sobre o diff da branch. Escopo é o que MUDOU — regra que acusa código
// não tocado vira paisagem e o aviso inteiro passa a ser ignorado.
//
// Cada regra tem exemplo certo e errado em autoteste(): `--autoteste` precisa passar antes de
// confiar em qualquer saída. Regra que acusa o jeito certo ensina a ignorar o aviso.
//
// uso: node qualidade/ferramentas/checar-diff.mjs <projeto> [base|--staged] [--ref=<branch>] [--json]
//      node qualidade/ferramentas/checar-diff.mjs <projeto> --corrigir [--ref=<branch>]
//      node qualidade/ferramentas/checar-diff.mjs --autoteste

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Diff, WORKSPACE } from '../lib/diff.mjs';

const RAIZ_WS = WORKSPACE;
const RAIZ_PROJETO = dirname(dirname(fileURLToPath(import.meta.url)));

// Regras que são do SEU time, não do projeto: `regras.json` ao lado do package.json.
// Ex.: { "specNovoProibido": ["nome-do-repo"] }
const REGRAS = (() => {
    try {
        return JSON.parse(readFileSync(join(RAIZ_PROJETO, 'regras.json'), 'utf8'));
    } catch {
        return {};
    }
})();

export class ChecarDiff {
    constructor() {
        this.regras = [
            {
                nome: 'comentario-acima-de-class',
                severidade: 'erro',
                doc: 'qualidade-de-codigo.md § Comentários',
                aplicar: a => this._acimaDeClass(a)
            },
            {
                nome: 'comentario-dentro-de-definition',
                severidade: 'erro',
                doc: 'qualidade-de-codigo.md § Comentários (model Mongoose)',
                aplicar: a => this._dentroDeDefinition(a)
            },
            {
                nome: 'comentario-bloco-longo',
                severidade: 'aviso',
                doc: 'máximo 2 linhas, exceto TODO',
                aplicar: a => this._blocoLongo(a)
            },
            {
                nome: 'declaracao-solta-em-arquivo-de-classe',
                severidade: 'erro',
                doc: 'qualidade-de-codigo.md § Estrutura',
                aplicar: a => this._soltaNoTopo(a)
            },
            {
                nome: 'literal-onde-cabe-enum',
                severidade: 'aviso',
                doc: 'derivar do enum, nunca repetir o valor',
                aplicar: a => this._literalDeDominio(a)
            },
            {
                nome: 'comentario-em-migration',
                severidade: 'erro',
                doc: 'migration não leva comentário nem console.log',
                aplicar: a => this._comentarioEmMigration(a)
            },
            {
                nome: 'console-log-em-migration',
                severidade: 'erro',
                doc: 'migration não leva comentário nem console.log',
                aplicar: a => this._consoleEmMigration(a)
            },
            {
                nome: 'spec-novo-onde-a-politica-nao-permite',
                severidade: 'aviso',
                doc: 'política do time: neste repo, só ajustar spec existente (regras.json)',
                aplicar: a => this._specNovoProibido(a)
            },
            {
                nome: 'arquivo-fora-da-pasta-convencional',
                severidade: 'aviso',
                doc: 'sufixo do arquivo determina a pasta',
                aplicar: a => this._pastaConvencional(a)
            }
        ];
        this.convencoes = [
            [/\.action\.js$/, /(^|\/)src\/actions\//],
            [/\.workflow\.js$/, /(^|\/)src\/(workflows|actions)\//],
            [/\.service\.js$/, /(^|\/)src\/.*services?\//],
            [/\.controller\.js$/, /(^|\/)src\/.*controllers?\//],
            [/\.router\.js$/, /(^|\/)src\/.*routers?\//],
            [/\.model\.js$/, /(^|\/)src\/.*models?\//],
            [/\.enum\.js$/, /(^|\/).*enums?\//],
            [/\.spec\.js$/, /(^|\/)(spec|test|tests|__tests__)\//]
        ];
    }

    // Caminho absoluto sempre: usado como módulo, o cwd é de quem importou, não do workspace.
    _raizDe(projeto) {
        return projeto.startsWith('/') ? projeto : join(RAIZ_WS, projeto);
    }

    git(projeto, ...args) {
        return execFileSync('git', ['-C', this._raizDe(projeto), ...args], {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore']
        });
    }

    // Delega ao Diff: a escolha da base é por topologia e já existia lá. Uma quarta cópia da ordem
    // fixa de nomes foi o que fez uma branch mesclada mostrar 17 arquivos de diff falso.
    resolverBase(projeto, base) {
        if (base) {
            return base;
        }
        return new Diff(projeto, this.ref || '').resolverBase();
    }

    _argsDiff(base, extras) {
        if (base === '--staged') {
            return ['diff', '--cached', ...extras];
        }
        // Com ref, compara aquela branch; sem, a árvore de trabalho.
        return this.ref ? ['diff', ...extras, base, this.ref] : ['diff', ...extras, base];
    }

    // Um `git diff -U0` para todos os arquivos. Um por arquivo eram N processos e 220 ms.
    _mapaDeAdicionadas(projeto, base) {
        const bruto = this.git(projeto, ...this._argsDiff(base, ['-U0']), '--');
        const mapa = new Map();
        let atual = null;
        let n = 0;
        for (const linha of bruto.split('\n')) {
            const cab = linha.match(/^\+\+\+ b\/(.+)$/);
            if (cab) {
                atual = new Set();
                mapa.set(cab[1], atual);
                continue;
            }
            const hunk = linha.match(/^@@ -\S+ \+(\d+)(?:,\d+)? @@/);
            if (hunk) {
                n = Number(hunk[1]);
                continue;
            }
            if (atual && linha.startsWith('+') && !linha.startsWith('+++')) {
                atual.add(n++);
            }
        }
        return mapa;
    }

    coletar(projeto, base) {
        const nomes = this.git(projeto, ...this._argsDiff(base, ['--name-status']), '--').trim();
        if (!nomes) {
            return [];
        }
        const arquivos = [];
        const mapaAdicionadas = this._mapaDeAdicionadas(projeto, base);
        for (const linha of nomes.split('\n')) {
            const partes = linha.split('\t');
            const estado = partes[0];
            const caminho = partes[partes.length - 1];
            if (estado === 'D' || !/\.(js|mjs|cjs)$/.test(caminho)) {
                continue;
            }
            // `git diff <base>` compara com a ÁRVORE; `--staged`, com o ÍNDICE. O conteúdo lido tem
            // que vir do mesmo lado, senão o número da linha aponta para outro texto.
            let conteudo = '';
            try {
                if (base === '--staged') {
                    conteudo = this.git(projeto, 'show', `:${caminho}`);
                } else if (this.ref) {
                    conteudo = this.git(projeto, 'show', `${this.ref}:${caminho}`);
                } else {
                    conteudo = readFileSync(join(this._raizDe(projeto), caminho), 'utf8');
                }
            } catch {
                try {
                    conteudo = this.git(projeto, 'show', `HEAD:${caminho}`);
                } catch {
                    continue;
                }
            }
            arquivos.push({
                caminho,
                novo: estado === 'A',
                linhas: conteudo.split('\n'),
                adicionadas: mapaAdicionadas.get(caminho) || new Set()
            });
        }
        return arquivos;
    }

    _ehComentario(linha = '') {
        return /^\s*(\/\/|\/\*|\*)/.test(linha);
    }

    _acimaDeClass(a) {
        const achados = [];
        a.linhas.forEach((linha, i) => {
            if (!/^\s*(export\s+(default\s+)?)?class\s+\w/.test(linha)) {
                return;
            }
            const acima = a.linhas[i - 1];
            if (!this._ehComentario(acima)) {
                return;
            }
            const nLinha = i + 1;
            if (a.novo || a.adicionadas.has(nLinha) || a.adicionadas.has(nLinha - 1)) {
                achados.push({ linha: nLinha - 1, trecho: acima.trim().slice(0, 70) });
            }
        });
        return achados;
    }

    _dentroDeDefinition(a) {
        const achados = [];
        let dentro = false;
        let profundidade = 0;
        a.linhas.forEach((linha, i) => {
            if (/const\s+definition\s*=\s*\{/.test(linha)) {
                dentro = true;
                profundidade = 1;
                return;
            }
            if (!dentro) {
                return;
            }
            profundidade += (linha.match(/\{/g) || []).length - (linha.match(/\}/g) || []).length;
            if (profundidade <= 0) {
                dentro = false;
                return;
            }
            if (this._ehComentario(linha) && (a.novo || a.adicionadas.has(i + 1))) {
                achados.push({ linha: i + 1, trecho: linha.trim().slice(0, 70) });
            }
        });
        return achados;
    }

    _blocoLongo(a) {
        const achados = [];
        let inicio = -1;
        let corrida = [];
        const fechar = () => {
            if (corrida.length > 2 && !corrida.some(l => /TODO|FIXME|eslint|@ts-|jsdoc|@param|@returns/i.test(l))) {
                const tocado = corrida.some((_, k) => a.adicionadas.has(inicio + k + 1));
                if (a.novo || tocado) {
                    achados.push({ linha: inicio + 1, trecho: `${corrida.length} linhas de comentário` });
                }
            }
            corrida = [];
            inicio = -1;
        };
        a.linhas.forEach((linha, i) => {
            if (this._ehComentario(linha)) {
                if (inicio < 0) {
                    inicio = i;
                }
                corrida.push(linha);
            } else {
                fechar();
            }
        });
        fechar();
        // Cabeçalho antes dos imports é permitido — a regra é o lugar, não a quantidade de linhas.
        const primeiroImport = a.linhas.findIndex(l => /^\s*(import\s|const\s+.*=\s*require\()/.test(l));
        const limite = primeiroImport < 0 ? 0 : primeiroImport;
        return achados.filter(x => x.linha > limite);
    }

    _soltaNoTopo(a) {
        if (!a.linhas.some(l => /^\s*(export\s+(default\s+)?)?class\s+\w/.test(l))) {
            return [];
        }
        const achados = [];
        const fimDoTopo = a.linhas.findIndex(l => /^\s*(export\s+(default\s+)?)?class\s+\w/.test(l));
        a.linhas.slice(0, fimDoTopo).forEach((linha, i) => {
            const mapa = /^const\s+([A-Z][A-Z0-9_]{1,})\s*=/.test(linha);
            const funcao = /^(const|let)\s+\w+\s*=\s*(async\s*)?(\([^)]*\)|\w+)\s*=>/.test(linha)
                || /^function\s+\w+/.test(linha);
            if ((mapa || funcao) && (a.novo || a.adicionadas.has(i + 1))) {
                achados.push({ linha: i + 1, trecho: linha.trim().slice(0, 70) });
            }
        });
        return achados;
    }

    // Só acusa literal comparado/atribuído a campo de domínio conhecido — comparação com 0/1
    // ou length dispara falso positivo e por isso está de fora.
    _literalDeDominio(a) {
        const campo = /\b(fase|status|tipo|tipoWorkflow|tipoIntegracao|situacao|origem)\b\s*(===?|!==?|:)\s*(\d{1,3})\b/;
        const achados = [];
        a.linhas.forEach((linha, i) => {
            if (this._ehComentario(linha) || !a.adicionadas.has(i + 1)) {
                return;
            }
            const m = linha.match(campo);
            if (m && !['0', '1'].includes(m[3])) {
                achados.push({ linha: i + 1, trecho: linha.trim().slice(0, 70) });
            }
        });
        return achados;
    }

    // A doutrina é uma frase só — "migration não leva comentário NEM console.log" — e eu havia
    // implementado apenas a segunda metade. Comentário de 2 linhas numa migration passava inteiro.
    // TODO e diretiva de ferramenta ficam: um carrega contexto de quem for implementar, a outra é
    // lida por máquina.
    _comentarioEmMigration(a) {
        if (!/migrations?\//.test(a.caminho)) {
            return [];
        }
        const achados = [];
        a.linhas.forEach((linha, i) => {
            if (!this._ehComentario(linha) || /TODO|FIXME|eslint|@ts-/i.test(linha)) {
                return;
            }
            if (a.novo || a.adicionadas.has(i + 1)) {
                achados.push({ linha: i + 1, trecho: linha.trim().slice(0, 70) });
            }
        });
        return achados;
    }

    _consoleEmMigration(a) {
        if (!/migrations?\//.test(a.caminho)) {
            return [];
        }
        const achados = [];
        a.linhas.forEach((linha, i) => {
            if (/console\.(log|info|debug)/.test(linha) && (a.novo || a.adicionadas.has(i + 1))) {
                achados.push({ linha: i + 1, trecho: linha.trim().slice(0, 70) });
            }
        });
        return achados;
    }

    // A decisão não é "proibido": o que muda a resposta é as classes vizinhas já terem spec.
    // Então a checagem traz esse número em vez de vetar.
    _specNovoProibido(a) {
        const proibidos = REGRAS.specNovoProibido || [];
        const nesteRepo = proibidos.some(r => (this.projeto || '').endsWith(r));
        if (!a.novo || !/\.spec\.js$/.test(a.caminho) || !nesteRepo) {
            return [];
        }
        const irmas = this._contarIrmas(a.caminho);
        const veredito = irmas > 0
            ? `spec novo — as irmãs já têm spec (${irmas}); precedente favorável, confirmar`
            : 'spec novo — nenhuma irmã tem spec; rodar a suíte e dizer se a cobertura foi perdida';
        return [{ linha: 1, trecho: veredito }];
    }

    _contarIrmas(caminho) {
        const pasta = caminho.slice(0, caminho.lastIndexOf('/'));
        try {
            const lista = this.git(this.projeto, 'ls-tree', '--name-only', 'HEAD', `${pasta}/`);
            return lista.split('\n').filter(l => /\.spec\.js$/.test(l) && !l.endsWith(caminho.split('/').pop())).length;
        } catch {
            return 0;
        }
    }

    _pastaConvencional(a) {
        if (!a.novo) {
            return [];
        }
        for (const [sufixo, pasta] of this.convencoes) {
            if (sufixo.test(a.caminho) && !pasta.test(a.caminho)) {
                return [{ linha: 1, trecho: `esperado em ${String(pasta).replace(/[\\^$()?:]/g, '')}` }];
            }
        }
        return [];
    }

    executar(projeto, base, ref = '') {
        this.projeto = projeto;
        this.ref = ref;
        const baseReal = this.resolverBase(projeto, base);
        const arquivos = this.coletar(projeto, baseReal);
        const achados = [];
        for (const a of arquivos) {
            for (const regra of this.regras) {
                for (const x of regra.aplicar(a)) {
                    if (this._suprimido(a, regra.nome, x.linha)) {
                        continue;
                    }
                    achados.push({ ...x, regra: regra.nome, severidade: regra.severidade, doc: regra.doc, caminho: a.caminho });
                }
            }
        }
        return { baseReal, arquivos: arquivos.length, achados };
    }

    // `// qualidade:ok <regra>` na linha, na anterior, ou no topo do arquivo. Sem escape, a regra
    // calibrada errado uma vez faz o usuário desligar o conjunto.
    _suprimido(a, nomeRegra, linha) {
        const marca = new RegExp(`qualidade:ok(\\s|:)+(${nomeRegra}|todas)`);
        const candidatas = [a.linhas[linha - 1], a.linhas[linha - 2], ...a.linhas.slice(0, 5)];
        return candidatas.some(l => l && marca.test(l));
    }

    // Só o que é mecânico: apagar linha não exige decidir nada. Bloco longo (quais 2 linhas ficam),
    // literal de enum (qual enum) e pasta errada (quebra os imports) continuam sendo julgamento.
    corrigir(projeto, base) {
        const CORRIGIVEIS = ['comentario-acima-de-class', 'comentario-dentro-de-definition',
            'comentario-em-migration', 'console-log-em-migration'];
        const r = this.executar(projeto, base);
        const alvo = r.achados.filter(a => CORRIGIVEIS.includes(a.regra));
        const porArquivo = new Map();
        for (const a of alvo) {
            if (!porArquivo.has(a.caminho)) {
                porArquivo.set(a.caminho, []);
            }
            porArquivo.get(a.caminho).push(a);
        }
        const feitos = [];
        for (const [caminho, achados] of porArquivo) {
            const absoluto = join(this._raizDe(projeto), caminho);
            let linhas;
            try {
                linhas = readFileSync(absoluto, 'utf8').split('\n');
            } catch {
                continue;
            }
            // De baixo para cima: apagar de cima desloca os números de baixo.
            for (const a of achados.sort((x, y) => y.linha - x.linha)) {
                const removida = linhas[a.linha - 1];
                if (removida === undefined || !this._ehComentario(removida) && !/console\.(log|info|debug)/.test(removida)) {
                    continue;
                }
                linhas.splice(a.linha - 1, 1);
                feitos.push({ caminho, linha: a.linha, regra: a.regra, texto: removida.trim() });
            }
            this._colapsarVazias(linhas, achados.map(x => x.linha));
            writeFileSync(absoluto, linhas.join('\n'));
        }
        const restantes = r.achados.filter(a => !CORRIGIVEIS.includes(a.regra));
        return { feitos, restantes, base: r.baseReal };
    }

    // Apagar comentário deixa duas linhas em branco onde havia uma: limpa o rastro da própria
    // correção, sem reformatar o resto do arquivo.
    _colapsarVazias(linhas, posicoes) {
        for (const pos of [...new Set(posicoes)].sort((a, b) => b - a)) {
            const i = pos - 1;
            const vazia = k => k >= 0 && k < linhas.length && linhas[k].trim() === '';
            if (vazia(i) && vazia(i - 1)) {
                linhas.splice(i, 1);
            }
        }
    }

    autoteste() {
        const casos = [
            ['comentario-acima-de-class', 'errado', '// faz coisa\nclass Foo {\n}\n', 1],
            ['comentario-acima-de-class', 'certo', 'import x from "y";\n\nclass Foo {\n    bar() {} // ordem importa\n}\n', 0],
            ['comentario-dentro-de-definition', 'errado', 'const definition = {\n    // id do cliente\n    idCliente: String\n};\n', 1],
            ['comentario-dentro-de-definition', 'certo', '// idResource tem dois significados\nconst definition = {\n    idCliente: String\n};\n', 0],
            ['declaracao-solta-em-arquivo-de-classe', 'errado', 'const MAPA = { a: 1 };\nclass Foo {}\n', 1],
            ['declaracao-solta-em-arquivo-de-classe', 'certo', 'import mapa from "./enums/mapa.enum.js";\nclass Foo {}\n', 0],
            ['literal-onde-cabe-enum', 'errado', 'if (conta.fase === 3) { return; }\n', 1],
            ['literal-onde-cabe-enum', 'certo', 'if (conta.fase === faseEnum.CONSENSO) { return; }\n', 0],
            ['comentario-bloco-longo', 'errado', 'import a from "b";\nconst z = 1;\n// linha um\n// linha dois\n// linha tres\nconst y = 2;\n', 1],
            ['comentario-bloco-longo', 'certo', 'import a from "b";\nconst z = 1;\n// ordem importa: publicar depois\n// senão a resposta é descartada\nconst y = 2;\n', 0],
            ['comentario-em-migration', 'errado', 'import C from "./C.js";\n\n// explica o porquê\nconst filter = {};\n', 1],
            ['comentario-em-migration', 'certo', 'import C from "./C.js";\n\nconst filter = {};\n', 0],
            ['comentario-em-migration', 'certo-todo', 'import C from "./C.js";\n// TODO: apagar quando o chamado ABC-123 subir\nconst filter = {};\n', 0],
            ['console-log-em-migration', 'errado', 'export const up = async db => {\n    console.log("subindo");\n    await db.x();\n};\n', 1],
            ['console-log-em-migration', 'certo', 'export const up = async db => {\n    await db.x();\n};\n', 0],
            ['console-log-em-migration', 'certo-fora-de-migration', 'const x = 1;\nconsole.log("ok");\n', 0]
        ];
        let falhas = 0;
        for (const [nomeRegra, esperado, fonte, qtd] of casos) {
            const regra = this.regras.find(r => r.nome === nomeRegra);
            // Caso `certo-fora-de-migration` precisa de caminho que NÃO é migration: é o que prova que
            // a regra não vaza para o resto do repo.
            const ehMigration = /migration/.test(nomeRegra) && esperado !== 'certo-fora-de-migration';
            const a = { caminho: ehMigration ? 'src/migrations/X/1-x.js' : 'src/foo.js', novo: true, linhas: fonte.split('\n'), adicionadas: new Set(fonte.split('\n').map((_, i) => i + 1)) };
            const achados = regra.aplicar(a);
            const ok = achados.length === qtd;
            if (!ok) {
                falhas++;
            }
            console.log(`${ok ? '✓' : '✗'} ${nomeRegra} [${esperado}] esperado ${qtd}, obtido ${achados.length}`);
        }
        console.log(falhas ? `\n${falhas} autoteste(s) falhando — não confiar na saída` : '\ntodos os autotestes passaram');
        return falhas === 0;
    }
}

// Importado como módulo (pelo servidor) não deve executar o CLI: era um processo node por
// requisição, 243 ms só de startup.
if (process.argv[1] !== fileURLToPath(import.meta.url)) {
    // usado como biblioteca
} else {
const c = new ChecarDiff();
const args = process.argv.slice(2);
if (args[0] === '--autoteste') {
    process.exit(c.autoteste() ? 0 : 1);
}
if (!args[0]) {
    console.error('uso: node checar-diff.mjs <projeto> [base] | --autoteste');
    process.exit(1);
}
if (args.includes('--corrigir')) {
    const pos = args.filter(a => !a.startsWith('--'));
    c.ref = (args.find(a => a.startsWith('--ref=')) || '').split('=')[1] || '';
    const r = c.corrigir(pos[0], args.includes('--staged') ? '--staged' : pos[1]);
    if (args.includes('--json')) {
        process.stdout.write(JSON.stringify(r));
        process.exit(0);
    }
    console.log(r.feitos.length ? `corrigido automaticamente (${r.feitos.length}):` : 'nada mecânico para corrigir');
    for (const f of r.feitos) {
        console.log(`  − ${f.caminho}:${f.linha}  [${f.regra}]  ${f.texto.slice(0, 70)}`);
    }
    if (r.restantes.length) {
        console.log(`\nexige julgamento (${r.restantes.length}):`);
        for (const a of r.restantes) {
            console.log(`  ! ${a.caminho}:${a.linha}  ${a.regra}  ${a.trecho.slice(0, 60)}`);
        }
    }
    process.exit(0);
}
const comoJson = args.includes('--json');
const posicionais = args.filter(a => !a.startsWith('--'));
// `--staged` é a base, não um posicional: filtrar tudo que começa com `--` o fazia ser ignorado em
// silêncio, e a checagem olhava a branch inteira em vez do índice.
const baseArg = args.includes('--staged') ? '--staged' : posicionais[1];
// Repo parado em outro checkout precisa do ref da branch do chamado, senão checa o trabalho errado.
const refArg = (args.find(a => a.startsWith('--ref=')) || '').split('=')[1] || '';
const r = c.executar(posicionais[0], baseArg, refArg);
const erros = r.achados.filter(x => x.severidade === 'erro');
if (comoJson) {
    process.stdout.write(JSON.stringify(r));
    process.exit(0);
}
console.log(`${r.arquivos} arquivo(s) .js no diff · base ${r.baseReal === '--staged' ? 'índice (staged)' : r.baseReal.slice(0, 12)}`);
if (!r.achados.length) {
    console.log('nenhum achado');
} else {
    for (const x of r.achados.sort((p, q) => p.caminho.localeCompare(q.caminho) || p.linha - q.linha)) {
        console.log(`  ${x.severidade === 'erro' ? '✗' : '!'} ${x.caminho}:${x.linha}  ${x.regra}\n      ${x.trecho}\n      ↳ ${x.doc}`);
    }
    console.log(`\n${erros.length} erro(s), ${r.achados.length - erros.length} aviso(s)`);
}
process.exit(erros.length ? 1 : 0);
}

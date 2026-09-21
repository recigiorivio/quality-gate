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
import ast, { CASOS_DE_QUERY } from '../lib/ast.mjs';

const RAIZ_WS = WORKSPACE;
// Extensões que as regras de texto cobrem. Fora daqui o arquivo é DECLARADO não analisado — silêncio
// lido como aprovação é o modo de falha que esta ferramenta existe para evitar.
const COBERTAS = /\.(js|mjs|cjs|jsx|ts|tsx)$/;
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
                doc: 'quality-qualidade-de-codigo.md § Comentários',
                aplicar: a => this._acimaDeClass(a)
            },
            {
                nome: 'comentario-dentro-de-definition',
                severidade: 'erro',
                doc: 'quality-qualidade-de-codigo.md § Comentários (model Mongoose)',
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
                doc: 'quality-qualidade-de-codigo.md § Estrutura',
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
            },
            {
                nome: 'model-de-outro-dominio',
                severidade: 'aviso',
                doc: 'quality-qualidade-de-codigo.md § Estrutura — procurar o service/comando do domínio antes de ler o model',
                aplicar: a => this._modelDeOutroDominio(a)
            }
        ];
        /*
         * Convenção de pasta é POR REPO, e cada linha só entra onde o repo de fato usa a pasta.
         * Medido em 03/09/2026 nos 5 repos: a lista global anterior acusava o padrão da casa em
         * massa — 427 dos 434 `.controller.js` do crohc-view, 132 de 132 `.router.js` do
         * crohc-server, 111 de 111 `.service.js` do contas. Esses repos organizam por domínio
         * (`components/<dominio>/<dominio>.service.js`); só o workflow-manager organiza por tipo.
         * `.router.js` saiu: não havia um único repo em que a pasta `routers/` existisse.
         */
        this.convencoes = {
            TODOS: [
                [/\.spec\.js$/, /(^|\/)(spec|test|tests|__tests__)\//]
            ],
            'workflow-manager': [
                [/\.action\.js$/, /(^|\/)src\/actions\//],
                [/\.workflow\.js$/, /(^|\/)src\/(workflows|actions)\//],
                [/\.service\.js$/, /(^|\/)src\/services\//],
                [/\.enum\.js$/, /(^|\/)enums?\//]
            ],
            // Enum em `enums/` é dominante aqui (97 de 123 no crohc-server, 106 de 113 na view),
            // mas NÃO no contas-service, onde os 41 ficam junto do domínio.
            'crohc-server': [
                [/\.enum\.js$/, /(^|\/)enums?\//],
                [/\.model\.js$/, /(^|\/)models?\//]
            ],
            'crohc-view': [
                [/\.enum\.js$/, /(^|\/)enums?\//]
            ],
            'migrate-mongo': [
                [/\.enum\.js$/, /(^|\/)enums?\//]
            ]
        };
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
            this.pendentes = null;
            return base;
        }
        // Guarda a instância: o `pendentes` dela é o que separa "mesclado por squash" de trabalho
        // aberto. Sem isso o diff dizia 0 arquivos e a cobertura dizia 11 não conferidos.
        const d = new Diff(projeto, this.ref || '');
        const real = d.resolverBase();
        this.pendentes = d.pendentes;
        return real;
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
        const naoAnalisados = [];
        this.apagados = 0;
        const mapaAdicionadas = this._mapaDeAdicionadas(projeto, base);
        for (const linha of nomes.split('\n')) {
            const partes = linha.split('\t');
            const estado = partes[0];
            const caminho = partes[partes.length - 1];
            if (estado === 'D') {
                this.apagados++;
                continue;
            }
            if (this.pendentes && !this.pendentes.has(caminho)) {
                continue;
            }
            // As regras aqui são de TEXTO (comentário, declaração no topo, literal), então valem em
            // TS e JSX sem parser. O que precisa de AST é a análise em lib/ast.mjs, e essa declara
            // separadamente o que não conseguiu ler.
            if (!COBERTAS.test(caminho)) {
                naoAnalisados.push(caminho);
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
        this.naoAnalisados = naoAnalisados;
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

    _convencoesDoProjeto() {
        const repo = String(this.projeto || '').replace(/\/$/, '').split('/').pop();
        return [...this.convencoes.TODOS, ...(this.convencoes[repo] || [])];
    }

    _pastaConvencional(a) {
        if (!a.novo) {
            return [];
        }
        for (const [sufixo, pasta] of this._convencoesDoProjeto()) {
            if (sufixo.test(a.caminho) && !pasta.test(a.caminho)) {
                return [{ linha: 1, trecho: `esperado em ${String(pasta).replace(/[\\^$()?:]/g, '')}` }];
            }
        }
        return [];
    }

    /*
     * `app.get(modelEnum.X)` numa linha nova de arquivo que nao e do dominio X. O dominio vem do nome do
     * model (ARQUIVO -> arquivo, GUIA_PROCESSAMENTO -> guia-processamento) e "ser do dominio" e ter uma
     * pasta ou o proprio nome do arquivo comecando por ele (`arquivos/`, `arquivo.service.js`,
     * `setor/` para SETOR_ATENDIMENTO). Nao sabe se o service existe: por isso e aviso, nao erro.
     */
    _modelDeOutroDominio(a) {
        if (/\.spec\.js$|(^|\/)(spec|models?|config)\//.test(a.caminho)) {
            return [];
        }
        const segmentos = a.caminho.toLowerCase().split('/');
        const nomeDoArquivo = segmentos[segmentos.length - 1].split('.')[0];
        const doDominio = dominio => [...segmentos.slice(0, -1), nomeDoArquivo].some(seg =>
            seg === dominio || seg === `${dominio}s` || seg.startsWith(dominio) || (seg.length >= 4 && dominio.startsWith(seg)));
        const achados = [];
        a.linhas.forEach((linha, i) => {
            if (!a.adicionadas.has(i + 1)) {
                return;
            }
            const m = /app\.get\(\s*(?:modelEnum|ModelEnum)\.([A-Z][A-Z0-9_]*)\s*\)/.exec(linha);
            if (!m) {
                return;
            }
            const dominio = m[1].toLowerCase().replace(/_/g, '-');
            if (!doDominio(dominio)) {
                achados.push({ linha: i + 1, trecho: `${m[0]} fora do domínio '${dominio}': há ${dominio}.service.js ou comando find? use-o` });
            }
        });
        return achados;
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
        return {
            baseReal,
            arquivos: arquivos.length,
            naoAnalisados: this.naoAnalisados || [],
            apagados: this.apagados || 0,
            extensoesNaoCobertas: [...new Set((this.naoAnalisados || [])
                .map(c => (c.match(/\.[a-z0-9]+$/i) || ['(sem extensão)'])[0]))].sort(),
            achados
        };
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

    // As regras de query alimentam o cartão de índices, não as checagens do diff, mas o autoteste é um
    // comando só: regra sem os dois lados provados é regra em que não se confia.
    _autotesteDeQueries() {
        let falhas = 0;
        for (const [nome, rotulo, fonte, risco, esperado] of CASOS_DE_QUERY) {
            const achadas = ast.queries(fonte) || [];
            const riscos = achadas.flatMap(q => q.riscos);
            const obtido = risco === null ? achadas.length > 0 : riscos.some(r => r.includes(risco));
            const ok = obtido === esperado;
            if (!ok) {
                falhas++;
            }
            console.log(`${ok ? '✓' : '✗'} ${nome} [${rotulo}] esperado ${esperado}, obtido ${obtido}`);
        }
        return falhas;
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
            ['console-log-em-migration', 'certo-fora-de-migration', 'const x = 1;\nconsole.log("ok");\n', 0],
            ['arquivo-fora-da-pasta-convencional', 'errado', 'export default class {}\n', 1,
                { caminho: 'src/manager/x.action.js', projeto: 'workflow-manager' }],
            ['arquivo-fora-da-pasta-convencional', 'certo', 'export default class {}\n', 0,
                { caminho: 'src/actions/x.action.js', projeto: 'workflow-manager' }],
            // O falso positivo que motivou a reescrita: controller de componente AngularJS mora
            // junto do componente, e são 427 de 434 assim no crohc-view.
            ['arquivo-fora-da-pasta-convencional', 'certo-controller-de-componente', 'export class X {}\n', 0,
                { caminho: 'src/app/shared/itens/components/sugestao-pacote/sugestao-pacote.controller.js', projeto: 'crohc-view' }],
            // Enum junto do domínio é o padrão do contas-service (41 de 41), e regra por repo respeita isso.
            ['arquivo-fora-da-pasta-convencional', 'certo-enum-do-contas', 'export default new X();\n', 0,
                { caminho: 'src/api/guia/execucao-acao-automatica.enum.js', projeto: 'contas-service' }],
            ['arquivo-fora-da-pasta-convencional', 'errado-enum-do-crohc-server', 'export default new X();\n', 1,
                { caminho: 'src/app/components/arquivos/x.enum.js', projeto: 'crohc-server' }],
            ['arquivo-fora-da-pasta-convencional', 'certo-spec', 'describe("x", () => {});\n', 0,
                { caminho: 'spec/x.spec.js', projeto: 'crohc-server' }],
            // O caso real: a ficha de pendencia lendo tiss_arquivo pelo model, com ArquivoService.findById existindo.
            ['model-de-outro-dominio', 'errado', 'const arquivo = await app.get(modelEnum.ARQUIVO).findById(id, {idCliente: 1}).lean();\n', 1,
                { caminho: 'src/api/alerta-integracao-cta-pendencia/alerta-integracao-cta-pendencia.service.js', projeto: 'contas-service' }],
            ['model-de-outro-dominio', 'errado-evolucao', 'const doc = await app.get(modelEnum.EVOLUCOES).findById(id);\n', 1,
                { caminho: 'src/api/guia-processamento/ativacoes/criar-ativacao-pendencia.js', projeto: 'contas-service' }],
            ['model-de-outro-dominio', 'certo-proprio-dominio', 'const model = app.get(modelEnum.EVOLUCOES);\n', 0,
                { caminho: 'src/api/evolucoes/evolucoes.service.js', projeto: 'contas-service' }],
            ['model-de-outro-dominio', 'certo-pasta-no-plural', 'const model = app.get(modelEnum.ARQUIVO);\n', 0,
                { caminho: 'src/app/components/arquivos/commands/arquivo-find.js', projeto: 'crohc-server' }],
            ['model-de-outro-dominio', 'certo-pasta-abreviada', 'const model = this.app.get(modelEnum.SETOR_ATENDIMENTO);\n', 0,
                { caminho: 'src/app/components/setor/setor-atendimento.service.js', projeto: 'crohc-server' }],
            // O workflow-manager organiza por tipo: o dominio esta no nome do arquivo, nao na pasta.
            ['model-de-outro-dominio', 'certo-organizado-por-tipo', 'const model = app.get(modelEnum.ARQUIVO);\n', 0,
                { caminho: 'src/services/arquivo.service.js', projeto: 'workflow-manager' }],
            ['model-de-outro-dominio', 'errado-organizado-por-tipo', 'const arquivos = await app.get(modelEnum.ARQUIVO).find({});\n', 1,
                { caminho: 'src/services/unificado/unificado-itens.service.js', projeto: 'workflow-manager' }],
            ['model-de-outro-dominio', 'certo-registro-de-models', 'app.set(x, connection.model(ModelEnum.ARQUIVO, schema));\n', 0,
                { caminho: 'src/config/models.js', projeto: 'workflow-manager' }],
            ['model-de-outro-dominio', 'certo-linha-antiga', 'const model = app.get(modelEnum.ARQUIVO);\n', 0,
                { caminho: 'src/api/guia/guia.service.js', projeto: 'contas-service', soNovas: false }]
        ];
        let falhas = 0;
        falhas += this._autotesteDeQueries();
        const projetoOriginal = this.projeto;
        for (const [nomeRegra, esperado, fonte, qtd, contexto] of casos) {
            const regra = this.regras.find(r => r.nome === nomeRegra);
            // Caso `certo-fora-de-migration` precisa de caminho que NÃO é migration: é o que prova que
            // a regra não vaza para o resto do repo.
            const ehMigration = /migration/.test(nomeRegra) && esperado !== 'certo-fora-de-migration';
            // A regra de pasta depende do repo: cada caso dela traz o seu.
            this.projeto = contexto?.projeto || projetoOriginal;
            const caminho = contexto?.caminho || (ehMigration ? 'src/migrations/X/1-x.js' : 'src/foo.js');
            const adicionadas = contexto?.soNovas === false ? new Set() : new Set(fonte.split('\n').map((_, i) => i + 1));
            const a = { caminho, novo: true, linhas: fonte.split('\n'), adicionadas };
            const achados = regra.aplicar(a);
            const ok = achados.length === qtd;
            if (!ok) {
                falhas++;
            }
            console.log(`${ok ? '✓' : '✗'} ${nomeRegra} [${esperado}] esperado ${qtd}, obtido ${achados.length}`);
        }
        this.projeto = projetoOriginal;
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
console.log(`${r.arquivos} arquivo(s) analisado(s) · base ${r.baseReal === '--staged' ? 'índice (staged)' : r.baseReal.slice(0, 12)}`);
if (r.naoAnalisados.length) {
    console.log(`⚠ ${r.naoAnalisados.length} arquivo(s) do diff NÃO analisados (${r.extensoesNaoCobertas.join(', ')})`);
    console.log('  Isso não é aprovação, é ausência de cobertura.');
}
if (!r.arquivos) {
    console.log('Nenhum arquivo coberto: não há o que aprovar aqui.');
}
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

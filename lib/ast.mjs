// Leitura de código por AST, não por regex. Duas regras desta ferramenta já acusaram o jeito CERTO
// por olharem UMA linha um problema que vive em VÁRIAS (comentário acima de `class`, filtro Mongo
// multilinha). Com AST isso deixa de ser possível: o nó carrega o começo e o fim.
//
// Cobre JS/MJS/CJS. Arquivo que não parseia (Python, Java, sintaxe futura) devolve null, e quem
// chamou decide o que dizer — nunca inventa achado sobre o que não conseguiu ler.

import * as acorn from '../vendor/acorn.mjs';

const OPERACOES_MONGO = new Set([
    'find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'findByIdAndUpdate',
    'updateOne', 'updateMany', 'deleteOne', 'deleteMany',
    'countDocuments', 'aggregate', 'distinct', 'bulkWrite', 'insertMany', 'insertOne'
]);
const NAO_E_COLECAO = /^(Object|Array|Promise|JSON|Math|String|Number|Date|_|lodash|axios|res|req|console)$/;
const CAMPOS_DE_RECORTE = new Set([
    '_id', 'idArquivo', 'idCliente', 'idConta', 'idDocumento', 'idAnexo', 'idGuia',
    'numeroAtendimento', 'idProntuario', 'idUsuario', 'idOperadora'
]);
const CAMPOS_DE_DOMINIO = new Set(['fase', 'status', 'tipo', 'tipoWorkflow', 'tipoIntegracao', 'situacao', 'origem']);

export class Ast {
    constructor() {
        this._pais = new WeakMap();
    }

    parse(fonte) {
        for (const sourceType of ['module', 'script']) {
            try {
                return acorn.parse(fonte, {
                    ecmaVersion: 'latest', sourceType, locations: true, allowHashBang: true
                });
            } catch {
                continue;
            }
        }
        return null;
    }

    // Percorre qualquer nó sem depender de uma lista de tipos: campo com `.type` é nó.
    // Guarda o pai porque `.find().sort()` põe o `sort` ACIMA do `find`, não na cadeia para dentro.
    andar(no, visitar, pai = null) {
        if (!no || typeof no !== 'object') {
            return;
        }
        if (no.type) {
            this._pais.set(no, pai);
            visitar(no);
        }
        for (const chave of Object.keys(no)) {
            if (chave === 'loc' || chave === 'start' || chave === 'end') {
                continue;
            }
            const valor = no[chave];
            if (Array.isArray(valor)) {
                for (const item of valor) {
                    this.andar(item, visitar, no);
                }
            } else if (valor && typeof valor === 'object' && valor.type) {
                this.andar(valor, visitar, no);
            }
        }
    }

    _nomeDe(no) {
        if (!no) {
            return null;
        }
        if (no.type === 'Identifier') {
            return no.name;
        }
        if (no.type === 'MemberExpression') {
            return no.property?.name ?? this._nomeDe(no.object);
        }
        if (no.type === 'CallExpression') {
            return this._nomeDe(no.callee);
        }
        return null;
    }

    _chaveDe(propriedade) {
        const k = propriedade.key;
        return k?.name ?? (typeof k?.value === 'string' ? k.value : null);
    }

    // ---------- queries Mongo ----------

    queries(fonte) {
        const ast = this.parse(fonte);
        if (!ast) {
            return null;
        }
        const achadas = [];
        this.andar(ast, no => {
            if (no.type !== 'CallExpression' || no.callee?.type !== 'MemberExpression') {
                return;
            }
            const operacao = no.callee.property?.name;
            if (!OPERACOES_MONGO.has(operacao)) {
                return;
            }
            const cru = this._nomeDe(no.callee.object);
            if (!cru || NAO_E_COLECAO.test(cru)) {
                return;
            }
            const arg = no.arguments[0];
            // `.find(x => ...)` é método de array, não do Mongo — o tipo do argumento separa os dois.
            if (arg && (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression')) {
                return;
            }
            achadas.push({
                linha: no.loc.start.line,
                colecao: cru.replace(/(Model|Repository|Collection)$/, '') || cru,
                operacao,
                filtro: this._descreverFiltro(arg),
                riscos: this._riscos(operacao, arg, no)
            });
        });
        return achadas;
    }

    _descreverFiltro(arg) {
        if (!arg) {
            return '(sem argumento)';
        }
        if (arg.type === 'ObjectExpression') {
            const campos = arg.properties
                .map(p => (p.type === 'SpreadElement' ? '...' : this._chaveDe(p)))
                .filter(Boolean);
            return `{ ${campos.join(', ')} }`;
        }
        if (arg.type === 'ArrayExpression') {
            return `[pipeline com ${arg.elements.length} estágio(s)]`;
        }
        if (arg.type === 'Identifier') {
            return `${arg.name} (variável)`;
        }
        return `(${arg.type})`;
    }

    _riscos(operacao, arg, chamada) {
        const riscos = [];
        const ehPipeline = operacao === 'aggregate' || operacao === 'bulkWrite';
        const ehEscrita = /^(insertMany|insertOne)$/.test(operacao);

        if (!ehPipeline && !ehEscrita) {
            if (!arg) {
                riscos.push('sem filtro — varre a coleção inteira');
            } else if (arg.type === 'ObjectExpression' && !arg.properties.length) {
                riscos.push('filtro vazio — varre a coleção inteira');
            }
        }
        if (arg?.type === 'ObjectExpression') {
            const chaves = arg.properties.map(p => this._chaveDe(p)).filter(Boolean);
            for (const chave of chaves) {
                if (chave.includes('.')) {
                    riscos.push(`filtro em campo aninhado '${chave}' — conferir índice nesse caminho`);
                }
                if (/^\$(ne|nin|not)$/.test(chave)) {
                    riscos.push(`operador negativo ${chave} — pouco seletivo`);
                }
            }
            for (const p of arg.properties) {
                riscos.push(...this._riscosDoValor(this._chaveDe(p), p.value));
            }
            // Filtro vazio já disse tudo; repetir "sem campo de recorte" é a mesma frase duas vezes.
            if (/^(updateMany|deleteMany)$/.test(operacao) && chaves.length
                && !chaves.some(c => CAMPOS_DE_RECORTE.has(c))) {
                riscos.push(`${operacao} sem campo de recorte no filtro — confirmar o alcance`);
            }
        }
        // `.sort()` sem `.limit()`: procura na cadeia de chamadas em volta, não no texto da linha.
        const cadeia = this._cadeia(chamada);
        if (cadeia.includes('sort') && !cadeia.includes('limit')) {
            riscos.push('sort sem limit');
        }
        return riscos;
    }

    _riscosDoValor(chave, valor) {
        const riscos = [];
        if (!valor) {
            return riscos;
        }
        if (valor.type === 'Literal' && valor.regex) {
            if (!valor.regex.pattern.startsWith('^')) {
                riscos.push(`regex sem âncora ^ em '${chave}' — não usa índice`);
            }
        }
        if (valor.type === 'ObjectExpression') {
            for (const p of valor.properties) {
                const sub = this._chaveDe(p);
                if (sub === '$regex') {
                    const v = p.value;
                    const texto = v?.regex?.pattern ?? (typeof v?.value === 'string' ? v.value : null);
                    if (texto !== null && !texto.startsWith('^')) {
                        riscos.push(`regex sem âncora ^ em '${chave}' — não usa índice`);
                    }
                }
                if (/^\$(ne|nin|not)$/.test(sub)) {
                    riscos.push(`operador negativo ${sub} em '${chave}' — pouco seletivo`);
                }
                if (sub === '$exists' && p.value?.value === false) {
                    riscos.push(`$exists:false em '${chave}' — pouco seletivo`);
                }
            }
        }
        return riscos;
    }

    // Nomes encadeados depois da chamada: sobe pelos pais enquanto for member/call da mesma cadeia.
    _cadeia(chamada) {
        const nomes = [];
        let atual = chamada;
        let pai = this._pais.get(atual);
        while (pai) {
            if (pai.type === 'MemberExpression' && pai.object === atual) {
                if (pai.property?.name) {
                    nomes.push(pai.property.name);
                }
            } else if (pai.type === 'CallExpression' && pai.callee === atual) {
                // segue: a chamada do membro que acabou de ser lido
            } else {
                break;
            }
            atual = pai;
            pai = this._pais.get(atual);
        }
        return nomes;
    }

    // ---------- métodos longos ----------

    // Tamanho real do corpo pelas posições do nó, não contando linhas até um `}` na mesma indentação.
    metodos(fonte) {
        const ast = this.parse(fonte);
        if (!ast) {
            return null;
        }
        const achados = [];
        this.andar(ast, no => {
            if (no.type !== 'MethodDefinition' && no.type !== 'FunctionDeclaration') {
                return;
            }
            const corpo = no.type === 'MethodDefinition' ? no.value?.body : no.body;
            if (!corpo?.loc) {
                return;
            }
            achados.push({
                nome: no.key?.name ?? no.id?.name ?? '(anônimo)',
                tipo: no.type === 'MethodDefinition' ? (no.kind || 'method') : 'function',
                inicio: no.loc.start.line,
                fim: corpo.loc.end.line,
                tamanho: corpo.loc.end.line - corpo.loc.start.line,
                sentencas: corpo.body?.length ?? 0,
                declarativo: this._ehBlocoDeDeclaracao(corpo)
            });
        });
        return achados;
    }

    // Corpo que é quase todo `this.X = ...` é bloco de DECLARAÇÃO, não lógica: é o padrão exigido em
    // enum, loader e workflow deste workspace (campos no construtor + Object.freeze). Reconhecer pela
    // forma cobre onde o arquivo estiver — a lista de pastas deixava o Collections.js escapar.
    _ehBlocoDeDeclaracao(corpo) {
        const sentencas = (corpo.body ?? []).filter(st => !(st.type === 'ExpressionStatement'
            && st.expression?.type === 'CallExpression' && st.expression.callee?.type === 'Super'));
        if (!sentencas.length) {
            return false;
        }
        const proporcao = n => n / sentencas.length;

        // Forma 1: campos no `this` — `this.AGRUPADOR = 'agrupadorItens'` × 210 (Collections, enums).
        const atribuicoes = sentencas.filter(st => this._ehAtribuicaoNoThis(st)).length;
        const congela = sentencas.some(st => /freeze/.test(JSON.stringify(st.expression?.callee ?? {})));
        if (proporcao(atribuicoes) >= 0.8 || (congela && proporcao(atribuicoes) >= 0.5)) {
            return true;
        }

        // Forma 2: tabela de registro — `this.actions.set(CHAVE, new X(app))` × 65 (loaders).
        const registros = sentencas.filter(st => st.type === 'ExpressionStatement'
            && st.expression?.type === 'CallExpression'
            && st.expression.callee?.type === 'MemberExpression'
            && /^(set|add|register|push|on|use)$/.test(st.expression.callee.property?.name ?? '')
            && this._raizEhThis(st.expression.callee.object));
        if (proporcao(registros.length + atribuicoes) >= 0.8) {
            return true;
        }

        // Forma 3: um único literal de dados domina o corpo — `this.workflow = { tarefas: [...] }`.
        const alturaCorpo = corpo.loc.end.line - corpo.loc.start.line;
        const dominante = sentencas.find(st => {
            const valor = st.type === 'ReturnStatement'
                ? st.argument
                : (this._ehAtribuicaoNoThis(st) ? st.expression.right : null);
            if (!valor || (valor.type !== 'ObjectExpression' && valor.type !== 'ArrayExpression')) {
                return false;
            }
            const altura = valor.loc.end.line - valor.loc.start.line;
            return alturaCorpo > 0 && altura / alturaCorpo >= 0.7;
        });
        return Boolean(dominante);
    }

    _ehAtribuicaoNoThis(st) {
        return st.type === 'ExpressionStatement'
            && st.expression?.type === 'AssignmentExpression'
            && st.expression.left?.type === 'MemberExpression'
            && this._raizEhThis(st.expression.left.object);
    }

    _raizEhThis(no) {
        let atual = no;
        while (atual?.type === 'MemberExpression') {
            atual = atual.object;
        }
        return atual?.type === 'ThisExpression';
    }

    // ---------- estrutura e comentários ----------

    // Declaração solta no topo de arquivo que declara classe: o nó diz se é de-para ou função.
    soltasNoTopo(fonte) {
        const comentarios = [];
        const ast = this.parse(fonte);
        if (!ast) {
            return null;
        }
        const primeiraClasse = ast.body.find(n => n.type === 'ClassDeclaration'
            || (n.type === 'ExportDefaultDeclaration' && n.declaration?.type === 'ClassDeclaration')
            || (n.type === 'ExportNamedDeclaration' && n.declaration?.type === 'ClassDeclaration'));
        if (!primeiraClasse) {
            return [];
        }
        const achados = [];
        for (const no of ast.body) {
            if (no.start >= primeiraClasse.start) {
                break;
            }
            if (no.type !== 'VariableDeclaration') {
                continue;
            }
            for (const d of no.declarations) {
                const nome = d.id?.name;
                if (!nome) {
                    continue;
                }
                const v = d.init;
                const ehMapa = v?.type === 'ObjectExpression' || v?.type === 'ArrayExpression';
                const ehFuncao = v?.type === 'ArrowFunctionExpression' || v?.type === 'FunctionExpression';
                if (ehMapa || ehFuncao) {
                    achados.push({
                        linha: no.loc.start.line,
                        nome,
                        forma: ehFuncao ? 'função' : 'de-para',
                        destino: ehFuncao ? 'método `_nome` da classe' : 'arquivo próprio em enums/'
                    });
                }
            }
        }
        return achados;
    }

    // Literal numérico comparado ou atribuído a campo de domínio — o nó dá o campo e o valor.
    literaisDeDominio(fonte) {
        const ast = this.parse(fonte);
        if (!ast) {
            return null;
        }
        const achados = [];
        const registrar = (campo, valor, linha) => {
            if (typeof valor !== 'number' || valor === 0 || valor === 1) {
                return;
            }
            achados.push({ linha, campo, valor });
        };
        this.andar(ast, no => {
            if (no.type === 'BinaryExpression' && /^[=!]==?$/.test(no.operator)) {
                const campo = no.left?.type === 'MemberExpression' ? no.left.property?.name : no.left?.name;
                if (campo && CAMPOS_DE_DOMINIO.has(campo) && no.right?.type === 'Literal') {
                    registrar(campo, no.right.value, no.loc.start.line);
                }
            }
            if (no.type === 'Property') {
                const chave = this._chaveDe(no);
                if (chave && CAMPOS_DE_DOMINIO.has(chave) && no.value?.type === 'Literal') {
                    registrar(chave, no.value.value, no.loc.start.line);
                }
            }
        });
        return achados;
    }
}

export default new Ast();

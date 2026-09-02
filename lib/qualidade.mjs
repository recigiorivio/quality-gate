// Traduz a saída das ferramentas nos itens de conferência que o usuário pediu.
// Cada item diz o que é: verificado por programa, ou julgamento que depende de olhar o diff.

import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE } from './diff.mjs';
import { Analise } from './analise.mjs';
import { ChecarDiff } from '../ferramentas/checar-diff.mjs';

const RAIZ = join(import.meta.dirname, '..');

export class Qualidade {
    ferramenta(nome, args) {
        try {
            return JSON.parse(execFileSync('node', [join(RAIZ, 'ferramentas', nome), ...args, '--json'], {
                cwd: WORKSPACE, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore']
            }));
        } catch {
            return null;
        }
    }

    // Os títulos que a tela mostra como "consultando…" antes de qualquer resposta. Fica aqui e não
    // na página para os rótulos não divergirem dos itens reais.
    esqueleto() {
        return [
            ['cobertura', 'Cobertura da análise', 'trabalho'],
            ['branch', 'Branch certa e chamado', 'trabalho'],
            ['testes', 'Política de testes', 'trabalho'],
            ['lint', 'Lint do projeto', 'trabalho'],
            ['indices', 'Índices e performance', 'dados'],
            ['refatoracao', 'Vale extrair ou eliminar?', 'refatoracao']
        ].map(([id, titulo, grupo]) => ({ id, titulo, status: 'carregando', detalhe: '', evidencia: [], grupo }));
    }

    async _ferramentaAsync(nome, args) {
        try {
            const { stdout } = await execFileAsync('node', [join(RAIZ, 'ferramentas', nome), ...args, '--json'], {
                cwd: WORKSPACE, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024
            });
            return JSON.parse(stdout);
        } catch {
            return null;
        }
    }

    _porRegra(achados, regras) {
        return achados.filter(a => regras.includes(a.regra));
    }

    _item(id, titulo, status, detalhe, evidencia = [], grupo = 'codigo') {
        return { id, titulo, status, detalhe, evidencia, grupo };
    }

    // Local e remoto separados porque as chamadas ao `gh` levam segundos: a tela desenha o que é
    // instantâneo primeiro, em vez de deixar tudo esperando a rede.
    local(chamado, projeto, ref = '') {
        let chk = null;
        try {
            chk = new ChecarDiff().executar(projeto, undefined, ref);
        } catch {
            chk = null;
        }
        const achados = chk?.achados || [];
        const itens = [];
        itens.push(this._itemCobertura(chk, projeto, ref));
        itens.push(...this._itensDoDiff(achados));
        itens.push(this._item('lint', 'Lint do projeto', 'manual', 'npm run check — rodar pelo botão', [], 'trabalho'));
        itens.push(this._itemIndices(projeto, chk?.baseReal, ref, chk));
        itens.push(this._itemRefatoracao(projeto, chk?.baseReal, ref, chk));
        return { chamado, projeto, base: chk?.baseReal ?? null, itens };
    }

    // Assíncrono porque é rede: o `gh` leva ~2,5 s e com execFileSync travava o event loop inteiro,
    // fazendo 3 requisições paralelas custarem mais que 3 sequenciais.
    async remoto(chamado, projeto) {
        const ctx = await this._ferramentaAsync('contexto.mjs', [chamado, `--projeto=${projeto}`]);
        const repo = ctx?.repos?.find(r => r.projeto === projeto) || null;
        return {
            chamado,
            projeto,
            branch: repo?.branch ?? null,
            ...this._estadoDoPr(repo),
            itens: this._itensDoRepo(repo, projeto, chamado)
        };
    }

    // O build só roda depois da PR aceita, então não é conferência de agora — o que vale aqui é
    // em que ponto a PR está.
    _estadoDoPr(repo) {
        const pr = repo?.pr;
        if (!pr) {
            return { prEstado: 'sem-pr', prRotulo: 'sem PR', prUrl: null };
        }
        const mapa = { MERGED: 'mergeado', OPEN: 'PR aberta', CLOSED: 'PR fechada' };
        return {
            prEstado: (mapa[pr.state] || pr.state).toLowerCase().replace(/\s+/g, '-'),
            prRotulo: (mapa[pr.state] || pr.state) + (pr.isDraft ? ' (draft)' : ''),
            prUrl: pr.url
        };
    }

    _itensDoRepo(repo, projeto) {
        const itens = [];
        if (!repo) {
            itens.push(this._item('branch', 'Branch certa e chamado', 'atencao',
                `${projeto} não está na branch do chamado`, [], 'trabalho'));
        } else {
            itens.push(this._item('branch', 'Branch certa e chamado',
                repo.nomeOk ? 'ok' : 'atencao',
                repo.nomeOk
                    ? `branch ${repo.branch} → ${repo.base?.nome ?? '?'}`
                    : `branch ${repo.branch} fora do padrão (esperado só o ID; renomear com PR aberto fecha o PR)`,
                repo.sujo ? [`${repo.sujo} arquivo(s) não commitado(s)`] : [], 'trabalho'));
        }

        return itens;
    }

    // Comentários, estrutura, enumeradores e pastas saíram da tela: são mecânicos, então são
    // corrigidos em vez de conferidos (ver `checar-diff.mjs --corrigir` e a rotina /final-trabalho).
    _itensDoDiff(achados) {
        const itens = [];
        const specs = this._porRegra(achados, ['spec-novo-onde-a-politica-nao-permite']);
        itens.push(this._item('testes', 'Política de testes', specs.length ? 'aviso' : 'manual',
            specs.length ? `${specs.length} spec(s) novo(s) neste repo` : 'rodar a suíte e conferir se o teste tem dentes',
            specs.map(a => `${a.caminho} — ${a.trecho}`)
                .concat('Reverter a correção e confirmar que o teste quebra'), 'trabalho'));
        return itens;
    }

    // Antes este cartão era um checklist estático. Agora lê as queries que entraram no diff — o que
    // ainda precisa de banco é só confirmar o plano de execução.
    // O denominador da conferência. Sem ele, "nenhum achado" num diff de 56 arquivos Python parece
    // aprovação — e é ausência de cobertura. Este cartão existe para essa frase não ser possível.
    _itemCobertura(chk, projeto, ref) {
        if (!chk) {
            return this._item('cobertura', 'Cobertura da análise', 'indisponivel',
                'não foi possível ler o diff deste repo', [], 'trabalho');
        }
        const analisados = chk.arquivos || 0;
        const fora = chk.naoAnalisados || [];
        const total = analisados + fora.length;
        if (!total) {
            return this._item('cobertura', 'Cobertura da análise', 'ok',
                'nenhuma alteração contra a base', [], 'trabalho');
        }
        if (!analisados) {
            return this._item('cobertura', 'Cobertura da análise', 'atencao',
                `0 de ${total} arquivo(s) analisados — nada aqui foi conferido`,
                [`extensões no diff: ${(chk.extensoesNaoCobertas || []).join(', ')}`,
                    'As checagens cobrem .js/.mjs/.cjs/.jsx/.ts/.tsx. Ausência de achado aqui NÃO é aprovação.',
                    'Para este repo, a conferência é o lint dele e a leitura do diff abaixo.'],
                'trabalho');
        }
        if (fora.length) {
            return this._item('cobertura', 'Cobertura da análise', 'aviso',
                `${analisados} de ${total} arquivo(s) analisados`,
                [`${fora.length} fora da cobertura: ${(chk.extensoesNaoCobertas || []).join(', ')}`,
                    'O que estiver nesses arquivos não foi conferido por nenhuma regra.'],
                'trabalho');
        }
        return this._item('cobertura', 'Cobertura da análise', 'ok',
            `${analisados} de ${total} arquivo(s) analisados`, [], 'trabalho');
    }

    // Repo sem nenhum arquivo coberto: o cartão não tem o que afirmar, e dizer "ok" seria afirmar.
    _semCobertura(chk) {
        return chk && (chk.arquivos || 0) === 0 && (chk.naoAnalisados || []).length > 0;
    }

    _itemIndices(projeto, base, ref = '', chk = null) {
        if (this._semCobertura(chk)) {
            return this._item('indices', 'Índices e performance', 'ignorado',
                `nenhum dos ${chk.naoAnalisados.length} arquivo(s) do diff é analisável aqui`,
                [`extensões: ${(chk.extensoesNaoCobertas || []).join(', ')}`], 'dados');
        }
        if (!base) {
            return this._item('indices', 'Índices e performance', 'indisponivel', 'base não resolvida — nada contra o que comparar', [], 'dados');
        }
        const analise = new Analise(projeto, ref);
        let queries = [];
        try {
            queries = analise.queries(base);
        } catch (e) {
            return this._item('indices', 'Índices e performance', 'indisponivel', `análise falhou: ${e.message}`, [], 'dados');
        }
        const naoLidos = analise.naoLidos || [];
        if (!queries.length) {
            // O parser é de JS: TypeScript, Python e Java caem aqui. Dizer "ok" sobre arquivo que
            // não foi lido é a mentira que este cartão precisa não contar.
            if (naoLidos.length) {
                return this._item('indices', 'Índices e performance', 'ignorado',
                    `${naoLidos.length} arquivo(s) não puderam ser lidos pelo parser (JS/JSX apenas)`,
                    naoLidos.slice(0, 6).concat(
                        'Nenhuma query foi procurada nesses arquivos — conferir à mão.'), 'dados');
            }
            return this._item('indices', 'Índices e performance', 'ok',
                'nenhuma query nova ou alterada nos arquivos analisados', [], 'dados');
        }
        const comRisco = queries.filter(q => q.riscos.length);
        const temEnv = existsSync(join(RAIZ, '.env'));
        const evidencia = queries.map(q => {
            const cabeca = `${q.arquivo}:${q.linha} — ${q.colecao}.${q.operacao}(${q.filtro.slice(0, 60)})`;
            return q.riscos.length ? `${cabeca}  ⚠ ${q.riscos.join(' · ')}` : cabeca;
        });
        if (!temEnv) {
            evidencia.push('plano de execução não confirmado: falta qualidade/.env com usuário Atlas de role read');
        } else {
            const primeira = queries[0];
            evidencia.push(`confirmar: node qualidade/ferramentas/indices.mjs ${primeira.colecao} '<filtro>'`);
        }
        return this._item('indices', 'Índices e performance', comRisco.length ? 'atencao' : 'manual',
            `${queries.length} query(ies) no diff · ${comRisco.length} com padrão de risco`, evidencia, 'dados');
    }

    _itemRefatoracao(projeto, base, ref = '', chk = null) {
        if (this._semCobertura(chk)) {
            return this._item('refatoracao', 'Vale extrair ou eliminar?', 'ignorado',
                `nenhum dos ${chk.naoAnalisados.length} arquivo(s) do diff é analisável aqui`,
                ['julgar pelo diff abaixo — nenhuma regra olhou estes arquivos'], 'refatoracao');
        }
        if (!base) {
            return this._item('refatoracao', 'Vale extrair ou eliminar?', 'indisponivel', 'base não resolvida — nada contra o que comparar', [], 'refatoracao');
        }
        let r = { repetidos: [], longos: [], jaExiste: [] };
        try {
            r = new Analise(projeto, ref).refatoracao(base);
        } catch (e) {
            return this._item('refatoracao', 'Vale extrair ou eliminar?', 'indisponivel', `análise falhou: ${e.message}`, [], 'refatoracao');
        }
        const evidencia = [
            ...r.longos.map(x => `${x.arquivo}:${x.linha} — ${x.metodo}() com ${x.tamanho} linhas: vale quebrar?`),
            ...r.repetidos.map(x => `bloco de ${x.linhas} linhas repetido ${x.vezes}× (${x.onde.join(', ')}) — "${x.amostra}"`),
            ...r.jaExiste.map(x => `'${x.nome}' já existe em ${x.arquivos.join(', ')}${x.total > x.arquivos.length ? ` (+${x.total - x.arquivos.length})` : ''} — reusar?`)
        ];
        const total = r.longos.length + r.repetidos.length + r.jaExiste.length;
        if (!total) {
            const naoLidos = r.naoLidos || [];
            if (naoLidos.length) {
                return this._item('refatoracao', 'Vale extrair ou eliminar?', 'ignorado',
                    `${naoLidos.length} arquivo(s) não puderam ser lidos pelo parser (JS/JSX apenas)`,
                    naoLidos.slice(0, 6).concat('Julgar pelo diff abaixo: a análise não cobriu estes.'),
                    'refatoracao');
            }
            return this._item('refatoracao', 'Vale extrair ou eliminar?', 'ok',
                'nada repetido, nenhum método longo novo, nenhum nome já existente', [], 'refatoracao');
        }
        return this._item('refatoracao', 'Vale extrair ou eliminar?', 'aviso',
            `${total} candidato(s): ${r.longos.length} longo(s) · ${r.repetidos.length} repetido(s) · ${r.jaExiste.length} já existe`,
            evidencia, 'refatoracao');
    }
}

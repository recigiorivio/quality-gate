// O estado que DOIS processos escrevem, num banco em vez de quatro JSONs.
//
// `lib/estado.mjs` continua certo para o que um processo só escreve (implantacao.json,
// linear-cache.json, ocultos.json): escrita atômica não deixa arquivo pela metade. O que ela não
// resolve é o que foi medido aqui:
//
//  1. **Perda de atualização.** `comparacoes.json` e `pontos-atencao.json` têm o servidor e as
//     ferramentas de CLI (`comparacao.mjs definir`, `pontos.mjs add`) escrevendo, cada um com
//     ler-alterar-gravar. O último a gravar leva o arquivo inteiro; o que o outro acabou de
//     escrever some sem erro. Aqui cada escrita é um `ON CONFLICT DO UPDATE` da própria linha, e o
//     `busy_timeout` faz o segundo processo ESPERAR em vez de gravar por cima.
//  2. **A lista inteira vindo do cliente.** `repos.salvar()` recebia os 51 repos da aba e
//     substituía o arquivo: provado com duas abas — a aba B gravou a cópia velha e a edição da aba
//     A desapareceu. Aqui a escrita é linha a linha, e linha que não veio na lista fica como está.
//  3. **O invariante do catálogo como código.** "linha `fonte:'manual'` a detecção não encosta" é
//     predicado de LINHA, e como blob foi implementado errado duas vezes no mesmo dia. Virou
//     `ON CONFLICT ... DO UPDATE ... WHERE repos.fonte = 'detectado'`: uma instrução que não
//     CONSEGUE tocar linha manual, e o `changes: 0` prova que não tocou.
//
//  4. **A marca de importação por PASTA.** A marca dizia "esta FONTE já entrou", e para as corridas
//     a fonte era o diretório: medido no banco de produção, a marca de `corridas` foi gravada às
//     19:40:50.542Z e o servidor gravou `corridas/UND-2026.json` 7,5 s depois — a corrida nunca
//     seria importada, e pasta vazia na primeira abertura selava a fonte antes do primeiro arquivo.
//     Agora a marca é por ARQUIVO e o corte da corrida é por registro, pela chave (chamado, início).
//  5. **Um registro torto derrubando a abertura inteira.** Severidade fora do enum num JSON VÁLIDO
//     fazia `abrir()` lançar; como a marca ia na mesma transação, nunca havia progresso e a tela
//     e todas as ferramentas caíam em TODA abertura. Agora o registro é recusado sozinho, com o
//     motivo na `observacao` da marca. Normalizar seria pior: inventaria o dado que ninguém
//     escreveu, e um `atencao` rebaixado a `nota` sai calado no teto. Arquivo ILEGÍVEL continua
//     gritando — ali não há registro para isolar e seguir apagaria o único backup.
//
// Quanto o segundo processo espera pelo primeiro (`busy_timeout`) é medida, não gosto: uma escrita
// real leva 0,10 ms de mediana, 12 processos disputando 480 linhas esperaram no máximo 115 ms, com
// 50 ms morrem 4 a 6 processos e somem 129 a 228 linhas. Como `node:sqlite` é síncrono e o servidor
// é um processo só, o mesmo número é o teto do CONGELAMENTO da tela: com 5000 ms um `BEGIN
// IMMEDIATE` esquecido em outro terminal parava toda requisição por 2,7 s; com 1000 ms a escrita
// falha com `database is locked` em 1,05 s e a tela mostra o erro.
//
// Sem dependência: `node:sqlite` é embutido. O `require` dele fica DENTRO de `abrir()` porque
// importar o módulo imprime `ExperimentalWarning` — assim `ferramentas/*.mjs --help` não imprime
// aviso nenhum, e o import deste arquivo não cria arquivo em disco.
//
// O que o esquema modela, e por quê:
//
//  - `decisoes` tem chave COMPOSTA porque a identidade é o par (chamado, projeto). Era a string
//    `"UND-1638|repo"` e `listar(chamado)` filtrava por `startsWith(chamado + '|')` — um WHERE
//    disfarçado de prefixo de texto, que erra em chamado cujo ID é prefixo de outro.
//  - `decisoes.extra` guarda campo que a decisão trouxe e o esquema não conhece: sem ele a ida e
//    volta para JSON perderia dado novo em silêncio, que é o defeito que esta migração conserta.
//  - `corridas` guarda HISTÓRICO. Antes era um arquivo por chamado com a ÚLTIMA corrida, e "a
//    corrida de ontem decidiu diferente" era a única pergunta que o formato não respondia.
//  - o teto de 10 pontos vive num TRIGGER, não só na função: como regra em JS ele valia apenas
//    para quem chamasse a função certa, e um `INSERT` cru passava por fora.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gravar } from './estado.mjs';

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));
const DOMINIOS = ['decisoes', 'repos', 'pontos', 'corridas'];
const SEVERIDADES = ['atencao', 'aviso', 'nota'];
const FONTES = ['detectado', 'manual'];
const CAMPOS_DECISAO = ['via', 'pr', 'estado', 'destino', 'branch', 'base', 'head', 'titulo',
    'url', 'situacao', 'nota', 'em'];

export const TETO_PONTOS = 10;

// Espera do segundo processo e, ao mesmo tempo, teto do congelamento da tela (números no cabeçalho).
// `QUALIDADE_BUSY_MS` sobe o número para quem tiver disco mais lento.
const OCUPADO_MS = 1000;

export const ESQUEMA = `
CREATE TABLE IF NOT EXISTS decisoes (
    chamado   TEXT NOT NULL,
    projeto   TEXT NOT NULL,
    via       TEXT,
    pr        INTEGER,
    estado    TEXT,
    destino   TEXT,
    branch    TEXT,
    base      TEXT,
    head      TEXT,
    titulo    TEXT,
    url       TEXT,
    situacao  TEXT,
    nota      TEXT,
    em        TEXT NOT NULL,
    extra     TEXT,
    PRIMARY KEY (chamado, projeto)
);

CREATE TABLE IF NOT EXISTS repos (
    projeto      TEXT PRIMARY KEY,
    origem       TEXT,
    destino      TEXT,
    fonte        TEXT NOT NULL DEFAULT 'detectado' CHECK (fonte IN ('detectado', 'manual')),
    ativo        INTEGER NOT NULL DEFAULT 0 CHECK (ativo IN (0, 1)),
    motivo       TEXT,
    atualizadoEm TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pontos (
    id         TEXT PRIMARY KEY,
    chamado    TEXT,
    projeto    TEXT,
    severidade TEXT NOT NULL CHECK (severidade IN ('atencao', 'aviso', 'nota')),
    titulo     TEXT NOT NULL,
    detalhe    TEXT,
    criadoEm   TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS pontos_teto BEFORE INSERT ON pontos
    WHEN (SELECT COUNT(*) FROM pontos) >= ${TETO_PONTOS}
     AND NEW.id NOT IN (SELECT id FROM pontos)
BEGIN
    SELECT RAISE(ABORT, 'pontos: teto de ${TETO_PONTOS} atingido — remova um antes de inserir outro');
END;

CREATE TABLE IF NOT EXISTS corridas (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chamado     TEXT NOT NULL,
    modelo      TEXT,
    esforco     TEXT,
    inicio      TEXT NOT NULL,
    fim         TEXT,
    segundos    INTEGER,
    ok          INTEGER CHECK (ok IN (0, 1)),
    resumo      TEXT,
    erro        TEXT,
    divergentes TEXT,
    UNIQUE (chamado, inicio)
);

CREATE INDEX IF NOT EXISTS idx_corridas_chamado ON corridas (chamado, inicio DESC);

CREATE TABLE IF NOT EXISTS corrida_eventos (
    corrida    INTEGER NOT NULL REFERENCES corridas (id) ON DELETE CASCADE,
    passo      INTEGER NOT NULL,
    em         TEXT,
    ferramenta TEXT,
    texto      TEXT,
    PRIMARY KEY (corrida, passo)
);

CREATE TABLE IF NOT EXISTS meta (
    chave TEXT PRIMARY KEY,
    valor TEXT
);

CREATE TABLE IF NOT EXISTS importacoes (
    arquivo    TEXT PRIMARY KEY,
    em         TEXT NOT NULL,
    linhas     INTEGER NOT NULL,
    observacao TEXT
);
`;

let banco = null;
// A conexão AINDA em preparo: pragma, esquema e importação chamam `abrir()` de volta e precisam
// vê-la. `banco` só recebe no fim, senão um preparo que falha fica publicado para sempre.
let preparando = null;

export function caminhoEstado() {
    return process.env.QUALIDADE_ESTADO || RAIZ;
}

export function caminhoBanco() {
    return join(caminhoEstado(), 'qualidade.db');
}

export function ocupadoMs() {
    const escolhido = Number(process.env.QUALIDADE_BUSY_MS);
    return Number.isFinite(escolhido) && escolhido >= 0 ? escolhido : OCUPADO_MS;
}

export function abrir() {
    if (banco) {
        return banco;
    }
    if (preparando) {
        return preparando;
    }
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const arquivo = caminhoBanco();
    mkdirSync(dirname(arquivo), { recursive: true });
    preparando = new DatabaseSync(arquivo);
    try {
        prepararConexao(preparando);
        importarDosJson();
        // Publicar só aqui: banco meio inicializado publicado nunca mais é refeito neste processo.
        banco = preparando;
    } catch (e) {
        try {
            preparando.close();
        } catch {
            // fechar pode falhar pela mesma causa que trouxe a gente aqui; o erro que interessa é `e`
        }
        throw e;
    } finally {
        preparando = null;
    }
    return banco;
}

function prepararConexao(conexao) {
    // `busy_timeout` PRIMEIRO. Sem espera, o segundo processo leva SQLITE_BUSY na cara em vez de
    // esperar a transação do primeiro — e é justamente a concorrência entre servidor e CLI que este
    // banco existe para tratar.
    conexao.exec(`PRAGMA busy_timeout = ${ocupadoMs()}`);
    // E a troca de journal_mode só quando ela é necessária, tolerando BUSY. Motivo medido: a troca
    // de journal_mode NÃO honra o busy handler, então com ela antes do timeout — ou incondicional —
    // vários processos abrindo o banco ao mesmo tempo morrem na hora com `database is locked`, com
    // stack e exit 1 no meio de um `definir`. Reproduzido em banco novo: 3 de 12 processos mortos e
    // 120 de 480 linhas perdidas, em 2 de 3 rodadas. `journal_mode` é propriedade do ARQUIVO, não da
    // conexão: basta um processo conseguir trocar, e os outros só precisam não morrer tentando.
    try {
        if (conexao.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') {
            conexao.exec('PRAGMA journal_mode = WAL');
        }
    } catch (e) {
        if (!/lock|busy/i.test(e.message)) {
            throw e;
        }
    }
    conexao.exec('PRAGMA foreign_keys = ON');
    conexao.exec(ESQUEMA);
}

export function fechar() {
    if (!banco) {
        return;
    }
    banco.close();
    banco = null;
}

// `undefined` e boolean o node:sqlite RECUSA no bind, e objeto posicional ele lê como saco de
// parâmetros nomeados ("Unknown named parameter"), erro que não diz onde está o problema.
export function paraSql(valor) {
    if (valor === undefined) {
        return null;
    }
    if (typeof valor === 'boolean') {
        return valor ? 1 : 0;
    }
    if (valor !== null && typeof valor === 'object' && !Buffer.isBuffer(valor)) {
        throw new TypeError('objeto não vai direto para coluna; use JSON.stringify antes');
    }
    return valor;
}

// Linha do node:sqlite vem com protótipo NULO: sem a cópia, `linha.hasOwnProperty` explode em
// qualquer código que a receba.
export function daLinha(linha, booleanos = []) {
    if (!linha) {
        return null;
    }
    const saida = { ...linha };
    for (const campo of booleanos) {
        if (saida[campo] !== null && saida[campo] !== undefined) {
            saida[campo] = Boolean(saida[campo]);
        }
    }
    return saida;
}

export function executar(sql, ...valores) {
    return abrir().prepare(sql).run(...valores.map(paraSql));
}

export function um(sql, ...valores) {
    return abrir().prepare(sql).get(...valores.map(paraSql)) || null;
}

export function todos(sql, ...valores) {
    return abrir().prepare(sql).all(...valores.map(paraSql));
}

export function transacao(fn) {
    const conexao = abrir();
    if (conexao.isTransaction) {
        return fn(conexao);
    }
    conexao.exec('BEGIN IMMEDIATE');
    try {
        const resultado = fn(conexao);
        conexao.exec('COMMIT');
        return resultado;
    } catch (e) {
        conexao.exec('ROLLBACK');
        throw e;
    }
}

// Upsert por chave, nunca ler-alterar-gravar: é isto que fecha a perda de atualização entre os dois
// processos. `condicao` é o invariante de linha (o `fonte = 'detectado'` do catálogo).
export function upsert(tabela, chaves, linha, condicao = null) {
    const campos = Object.keys(linha);
    const atualiza = campos.filter(c => !chaves.includes(c)).map(c => `${c} = excluded.${c}`);
    const acao = atualiza.length
        ? `DO UPDATE SET ${atualiza.join(', ')}${condicao ? ` WHERE ${condicao}` : ''}`
        : 'DO NOTHING';
    const sql = `INSERT INTO ${tabela} (${campos.join(', ')})`
        + ` VALUES (${campos.map(() => '?').join(', ')})`
        + ` ON CONFLICT (${chaves.join(', ')}) ${acao}`;
    return executar(sql, ...campos.map(c => linha[c]));
}

// Serve de chave de cache no servidor. Antes era o mtime do JSON; num banco não existe mtime por
// domínio, e sem isto a resposta velha continuaria sendo servida depois de o agente decidir.
export function versao(dominio = 'tudo') {
    if (dominio === 'tudo') {
        return DOMINIOS.reduce((soma, d) => soma + versao(d), 0);
    }
    return Number(um('SELECT valor FROM meta WHERE chave = ?', `versao.${dominio}`)?.valor || 0);
}

export function meta(chave, valor = undefined) {
    if (valor === undefined) {
        return um('SELECT valor FROM meta WHERE chave = ?', chave)?.valor ?? null;
    }
    upsert('meta', ['chave'], { chave, valor });
    return valor;
}

export function relatorioImportacao() {
    return todos('SELECT * FROM importacoes ORDER BY arquivo').map(l => daLinha(l));
}

function novaVersao(dominio) {
    executar(`INSERT INTO meta (chave, valor) VALUES (?, '1')
        ON CONFLICT (chave) DO UPDATE SET valor = CAST(meta.valor AS INTEGER) + 1`, `versao.${dominio}`);
}

function semNulos(objeto) {
    return Object.fromEntries(Object.entries(objeto).filter(([, v]) => v !== null && v !== undefined));
}

function agora() {
    return new Date().toISOString();
}

class Decisoes {
    // Decisão sem chamado existia como a chave `"?|projeto"`; manter o `?` é o que faz a linha antiga
    // continuar sendo encontrada pelo mesmo par.
    chave(chamado) {
        return String(chamado || '?');
    }

    obter(chamado, projeto) {
        return this._daLinha(um('SELECT * FROM decisoes WHERE chamado = ? AND projeto = ?',
            this.chave(chamado), String(projeto)));
    }

    listar(chamado = null) {
        const linhas = chamado
            ? todos('SELECT * FROM decisoes WHERE chamado = ? ORDER BY projeto', this.chave(chamado))
            : todos('SELECT * FROM decisoes ORDER BY chamado, projeto');
        return linhas.map(l => this._daLinha(l));
    }

    // A forma antiga do arquivo: `{ "CHAMADO|projeto": { ...decisao } }`.
    mapa(chamado = null) {
        return Object.fromEntries(this.listar(chamado).map(({ chamado: c, projeto, ...resto }) =>
            [`${c}|${projeto}`, resto]));
    }

    chamados() {
        return todos('SELECT DISTINCT chamado FROM decisoes ORDER BY chamado').map(l => l.chamado);
    }

    definir(chamado, projeto, decisao = {}) {
        const linha = { chamado: this.chave(chamado), projeto: String(projeto), extra: null };
        const extra = {};
        for (const [campo, valor] of Object.entries(decisao)) {
            if (campo === 'chamado' || campo === 'projeto' || campo === 'extra') {
                continue;
            }
            if (CAMPOS_DECISAO.includes(campo)) {
                linha[campo] = valor === undefined ? null : valor;
            } else {
                extra[campo] = valor;
            }
        }
        for (const campo of CAMPOS_DECISAO) {
            linha[campo] = linha[campo] ?? null;
        }
        linha.em = decisao.em || agora();
        linha.extra = Object.keys(extra).length ? JSON.stringify(extra) : null;
        transacao(() => {
            upsert('decisoes', ['chamado', 'projeto'], linha);
            novaVersao('decisoes');
        });
        return this.obter(chamado, projeto);
    }

    remover(chamado, projeto) {
        return transacao(() => {
            const r = executar('DELETE FROM decisoes WHERE chamado = ? AND projeto = ?',
                this.chave(chamado), String(projeto));
            novaVersao('decisoes');
            return r.changes > 0;
        });
    }

    contar(chamado = null) {
        const sql = chamado
            ? 'SELECT COUNT(*) AS total FROM decisoes WHERE chamado = ?'
            : 'SELECT COUNT(*) AS total FROM decisoes';
        return Number((chamado ? um(sql, this.chave(chamado)) : um(sql)).total);
    }

    // Campo nulo sai FORA: a decisão nunca preencheu as 12 colunas, e devolver `url: null` em toda
    // linha sujaria o JSON exportado sem dizer nada que a ausência já não diga.
    _daLinha(linha) {
        if (!linha) {
            return null;
        }
        const { extra, ...resto } = daLinha(linha);
        return { ...semNulos(resto), ...(extra ? JSON.parse(extra) : {}) };
    }
}

class CatalogoRepos {
    listar() {
        return todos('SELECT * FROM repos ORDER BY projeto').map(l => daLinha(l, ['ativo']));
    }

    obter(projeto) {
        return daLinha(um('SELECT * FROM repos WHERE projeto = ?', String(projeto)), ['ativo']);
    }

    ativos() {
        return todos(`SELECT * FROM repos WHERE ativo = 1 AND origem IS NOT NULL
            AND destino IS NOT NULL ORDER BY projeto`).map(l => daLinha(l, ['ativo']));
    }

    par(projeto) {
        const r = this.obter(projeto);
        return r?.origem && r?.destino ? { origem: r.origem, destino: r.destino } : null;
    }

    definir(entrada) {
        const linha = this._linha(entrada);
        transacao(() => {
            upsert('repos', ['projeto'], linha);
            novaVersao('repos');
        });
        return this.obter(linha.projeto);
    }

    // A lista inteira que vem da tela, gravada LINHA A LINHA. Repo que não veio na lista fica como
    // está — é o conserto do caso das duas abas, em que a aba B ressuscitava a cópia velha da A.
    salvarVarias(entradas) {
        return transacao(() => {
            for (const entrada of entradas) {
                upsert('repos', ['projeto'], this._linha(entrada));
            }
            novaVersao('repos');
            return this.listar();
        });
    }

    // O invariante mora no WHERE do upsert: ele não CONSEGUE mudar origem, destino, ativo nem
    // fonte de linha manual. O único campo que a detecção escreve em linha manual é o `motivo`.
    gravarDetectados(achados) {
        return transacao(() => {
            for (const achado of achados) {
                const linha = this._linha({ ...achado, fonte: 'detectado' });
                upsert('repos', ['projeto'], linha, "repos.fonte = 'detectado'");
            }
            const vistos = achados.map(a => String(a.projeto));
            const lacunas = vistos.map(() => '?').join(', ') || 'NULL';
            executar(`UPDATE repos SET motivo = 'a pasta não existe mais no workspace'
                WHERE fonte = 'manual' AND projeto NOT IN (${lacunas})`, ...vistos);
            executar(`DELETE FROM repos WHERE fonte = 'detectado' AND projeto NOT IN (${lacunas})`, ...vistos);
            meta('repos.detectadoEm', agora());
            novaVersao('repos');
            return this.listar();
        });
    }

    remover(projeto) {
        return transacao(() => {
            const r = executar('DELETE FROM repos WHERE projeto = ?', String(projeto));
            novaVersao('repos');
            return r.changes > 0;
        });
    }

    detectadoEm() {
        return meta('repos.detectadoEm');
    }

    marcarDeteccao(em = agora()) {
        return meta('repos.detectadoEm', em);
    }

    contar() {
        return Number(um('SELECT COUNT(*) AS total FROM repos').total);
    }

    _linha(entrada) {
        const projeto = String(entrada.projeto || '').trim();
        if (!projeto) {
            throw new Error('repo sem projeto');
        }
        const origem = entrada.origem ? String(entrada.origem).trim() : null;
        const destino = entrada.destino ? String(entrada.destino).trim() : null;
        const fonte = FONTES.includes(entrada.fonte) ? entrada.fonte : 'detectado';
        return {
            projeto,
            origem,
            destino,
            fonte,
            // `ativo` só é verdade com o par completo: ligado sem origem ou destino não tem o que comparar.
            ativo: Boolean(entrada.ativo ?? (origem && destino)) && Boolean(origem && destino),
            motivo: entrada.motivo ?? null,
            atualizadoEm: entrada.atualizadoEm || agora()
        };
    }
}

class Pontos {
    get teto() {
        return TETO_PONTOS;
    }

    listar() {
        return todos('SELECT * FROM pontos ORDER BY criadoEm, id').map(l => daLinha(l));
    }

    obter(id) {
        return daLinha(um('SELECT * FROM pontos WHERE id = ?', String(id)));
    }

    // Nulo em `chamado`/`projeto` quer dizer "vale para o workspace", e por isso entra em toda tela.
    para(chamado = null, projeto = null) {
        return todos(`SELECT * FROM pontos
            WHERE (chamado IS NULL OR chamado = ?) AND (projeto IS NULL OR projeto = ?)
            ORDER BY criadoEm, id`, chamado ?? null, projeto ?? null).map(l => daLinha(l));
    }

    // O teto é o freio: ponto novo só entra empurrando um velho, senão a lista vira despejo. E o
    // descarte olha a severidade antes da idade — uma `nota` de hoje empurrava fora um `atencao`.
    gravar(ponto) {
        if (!ponto?.id) {
            throw new Error('ponto sem id');
        }
        if (!SEVERIDADES.includes(ponto.severidade)) {
            throw new Error(`severidade deve ser uma de: ${SEVERIDADES.join(', ')}`);
        }
        const linha = {
            id: String(ponto.id),
            chamado: ponto.chamado || null,
            projeto: ponto.projeto || null,
            severidade: ponto.severidade,
            titulo: String(ponto.titulo || ''),
            detalhe: ponto.detalhe ?? null,
            criadoEm: ponto.criadoEm || agora().slice(0, 10)
        };
        return transacao(() => {
            const descartados = [];
            while (!this.obter(linha.id) && this.contar() >= TETO_PONTOS) {
                const vitima = this._proximoADescartar(linha.id);
                if (!vitima) {
                    throw new Error(`teto de ${TETO_PONTOS} atingido e todos os pontos são 'atencao'.\n`
                        + 'Tire um à mão antes: node ferramentas/pontos.mjs remover <id>\n'
                        + `Atuais: ${this.listar().map(p => p.id).join(', ')}`);
                }
                executar('DELETE FROM pontos WHERE id = ?', vitima.id);
                descartados.push(vitima.id);
            }
            upsert('pontos', ['id'], linha);
            novaVersao('pontos');
            return { total: this.contar(), descartados };
        });
    }

    remover(id) {
        return transacao(() => {
            const r = executar('DELETE FROM pontos WHERE id = ?', String(id));
            novaVersao('pontos');
            return { removidos: r.changes, total: this.contar() };
        });
    }

    contar() {
        return Number(um('SELECT COUNT(*) AS total FROM pontos').total);
    }

    // `nota` sai antes de `aviso`, e `atencao` nunca sai. Dentro da mesma severidade, o mais antigo.
    _proximoADescartar(idEntrando) {
        return daLinha(um(`SELECT * FROM pontos WHERE id <> ? AND severidade IN ('nota', 'aviso')
            ORDER BY CASE severidade WHEN 'nota' THEN 0 ELSE 1 END, criadoEm, id LIMIT 1`,
            String(idEntrando)));
    }
}

class Corridas {
    iniciar(corrida = {}) {
        const inicio = corrida.inicio || agora();
        const chamado = String(corrida.chamado || '');
        if (!chamado) {
            throw new Error('corrida sem chamado');
        }
        return transacao(() => {
            upsert('corridas', ['chamado', 'inicio'], {
                chamado,
                inicio,
                modelo: corrida.modelo ?? null,
                esforco: corrida.esforco ?? null
            });
            novaVersao('corridas');
            return this._id(chamado, inicio);
        });
    }

    evento(id, evento = {}) {
        transacao(() => {
            upsert('corrida_eventos', ['corrida', 'passo'], {
                corrida: Number(id),
                passo: Number(evento.passo),
                em: evento.em || agora(),
                ferramenta: evento.ferramenta ?? null,
                texto: evento.texto ?? null
            });
            novaVersao('corridas');
        });
        return Number(id);
    }

    eventos(id) {
        return todos('SELECT passo, em, ferramenta, texto FROM corrida_eventos WHERE corrida = ? ORDER BY passo',
            Number(id)).map(l => semNulos(daLinha(l)));
    }

    finalizar(id, fim = {}) {
        return transacao(() => {
            executar(`UPDATE corridas SET fim = ?, segundos = ?, ok = ?, resumo = ?, erro = ?, divergentes = ?
                WHERE id = ?`,
                fim.fim || agora(),
                fim.segundos ?? null,
                fim.ok ?? null,
                fim.resumo ?? null,
                fim.erro ?? null,
                fim.divergentes ? JSON.stringify(fim.divergentes) : null,
                Number(id));
            novaVersao('corridas');
            return this.obter(id);
        });
    }

    // A corrida inteira de uma vez, do jeito que o servidor a acumula em memória. Identidade é
    // (chamado, início): regravar a mesma corrida atualiza, e a corrida seguinte é outra linha.
    gravar(corrida) {
        // A forma AGRUPADA do `exportarJson` não é uma corrida: sem esta recusa ela virava uma linha
        // com o início de agora, sem eventos e sem erro — o único jeito de a ida e volta corromper.
        if (Array.isArray(corrida?.corridas)) {
            throw new TypeError('isto é um grupo `{chamado, corridas:[...]}`, não uma corrida');
        }
        const chamado = String(corrida?.chamado || '');
        if (!chamado) {
            throw new Error('corrida sem chamado');
        }
        const inicio = corrida.inicio || agora();
        return transacao(() => {
            upsert('corridas', ['chamado', 'inicio'], {
                chamado,
                inicio,
                modelo: corrida.modelo ?? null,
                esforco: corrida.esforco ?? null,
                fim: corrida.fim ?? null,
                segundos: corrida.segundos ?? null,
                ok: corrida.ok ?? null,
                resumo: corrida.resumo ?? null,
                erro: corrida.erro ?? null,
                divergentes: corrida.divergentes ? JSON.stringify(corrida.divergentes) : null
            });
            const id = this._id(chamado, inicio);
            executar('DELETE FROM corrida_eventos WHERE corrida = ?', id);
            for (const [indice, evento] of (corrida.eventos || []).entries()) {
                upsert('corrida_eventos', ['corrida', 'passo'], {
                    corrida: id,
                    passo: Number(evento.passo ?? indice + 1),
                    em: evento.em ?? null,
                    ferramenta: evento.ferramenta ?? null,
                    texto: evento.texto ?? null
                });
            }
            novaVersao('corridas');
            return id;
        });
    }

    obter(id) {
        const linha = daLinha(um('SELECT * FROM corridas WHERE id = ?', Number(id)), ['ok']);
        if (!linha) {
            return null;
        }
        linha.divergentes = linha.divergentes ? JSON.parse(linha.divergentes) : [];
        linha.eventos = this.eventos(linha.id);
        return linha;
    }

    ultima(chamado) {
        const linha = um('SELECT id FROM corridas WHERE chamado = ? ORDER BY inicio DESC, id DESC LIMIT 1',
            String(chamado));
        return linha ? this.obter(linha.id) : null;
    }

    // Sem os eventos: é a lista para escolher qual corrida abrir, e uma corrida real tem dezenas.
    historico(chamado = null, limite = 50) {
        const sql = `SELECT id, chamado, modelo, esforco, inicio, fim, segundos, ok, resumo, erro
            FROM corridas${chamado ? ' WHERE chamado = ?' : ''} ORDER BY inicio DESC, id DESC LIMIT ?`;
        const linhas = chamado
            ? todos(sql, String(chamado), Number(limite))
            : todos(sql, Number(limite));
        return linhas.map(l => daLinha(l, ['ok']));
    }

    chamados() {
        return todos('SELECT chamado, MAX(inicio) AS ultima FROM corridas GROUP BY chamado ORDER BY ultima DESC')
            .map(l => l.chamado);
    }

    remover(id) {
        return transacao(() => {
            const r = executar('DELETE FROM corridas WHERE id = ?', Number(id));
            novaVersao('corridas');
            return r.changes > 0;
        });
    }

    contar(chamado = null) {
        const sql = chamado
            ? 'SELECT COUNT(*) AS total FROM corridas WHERE chamado = ?'
            : 'SELECT COUNT(*) AS total FROM corridas';
        return Number((chamado ? um(sql, String(chamado)) : um(sql)).total);
    }

    // `lastInsertRowid` mente quando o upsert virou UPDATE, então o id sai de uma consulta pela chave.
    _id(chamado, inicio) {
        return Number(um('SELECT id FROM corridas WHERE chamado = ? AND inicio = ?', chamado, inicio).id);
    }
}

export const decisoes = new Decisoes();
export const repos = new CatalogoRepos();
export const pontos = new Pontos();
export const corridas = new Corridas();

// Os JSONs ficam no disco depois de importados: são o backup de quem migra. A marca em
// `importacoes` é por ARQUIVO, nunca por pasta — o porquê está no item 4 do cabeçalho.
function importarDosJson() {
    const feitas = new Set(todos('SELECT arquivo FROM importacoes').map(l => l.arquivo));
    if (feitas.has('corridas')) {
        // Quem migrou antes tem a marca da pasta; ela não corresponde a arquivo nenhum e sai.
        executar("DELETE FROM importacoes WHERE arquivo = 'corridas'");
    }
    for (const fonte of fontesDeImportacao()) {
        if (!existsSync(join(caminhoEstado(), fonte.arquivo))) {
            continue;
        }
        // A marca só PULA fonte de arquivo único. Para as corridas ela é registro do que já entrou,
        // não tranca: o corte real é por (chamado, início) lá dentro. Pulando pela marca, um
        // `corridas/<X>.json` reescrito com outra corrida depois da importação nunca mais era lido
        // — e um arquivo que nasceu 7 s depois da marca da pasta ficou fora para sempre no banco
        // real do usuário.
        if (fonte.tabela && feitas.has(fonte.arquivo)) {
            continue;
        }
        // Importação e marca na MESMA transação: import que falha no meio não pode deixar linha
        // gravada sem marca, senão o boot seguinte lê isso como "banco já em uso" e desiste.
        transacao(() => {
            const havia = fonte.tabela
                ? Number(um(`SELECT COUNT(*) AS total FROM ${fonte.tabela}`).total)
                : 0;
            // Tabela com linha e sem marca é banco que alguém já usou: importar aqui seria escrever
            // por cima do que está em uso, que é o defeito que esta migração vem consertar.
            const resultado = havia
                ? { linhas: 0, observacao: `a tabela já tinha ${havia} linhas; nada foi importado` }
                : importarTolerando(fonte);
            upsert('importacoes', ['arquivo'], {
                arquivo: fonte.arquivo,
                em: agora(),
                linhas: resultado.linhas,
                observacao: resultado.observacao ?? null
            });
        });
    }
}

// Arquivo único ilegível continua GRITANDO: ali o JSON é o backup, e seguir em frente apagaria a
// única cópia do estado de quem migra. Já uma corrida podre é UM registro entre muitos — deixar
// que ela derrube o boot matava o servidor em toda requisição, para sempre, porque sem marca o
// arquivo era retentado a cada abertura. Aqui ela é recusada, registrada com o motivo, e o resto
// entra. Recusar não é engolir: o motivo fica na marca e aparece em `npm run banco importacoes`.
function importarTolerando(fonte) {
    if (fonte.tabela) {
        return fonte.importar();
    }
    try {
        return fonte.importar();
    } catch (e) {
        return { linhas: 0, observacao: `recusado: ${e.message}` };
    }
}

// Os três arquivos únicos, mais UMA fonte por arquivo de corrida. As corridas não levam `tabela`
// porque o corte delas é por registro, pela chave (chamado, início), e não pela tabela estar vazia.
function fontesDeImportacao() {
    const fontes = [
        { arquivo: 'comparacoes.json', tabela: 'decisoes', importar: importarComparacoes },
        { arquivo: 'pontos-atencao.json', tabela: 'pontos', importar: importarPontos },
        { arquivo: 'repos.json', tabela: 'repos', importar: importarRepos }
    ];
    const pasta = join(caminhoEstado(), 'corridas');
    if (existsSync(pasta)) {
        for (const nome of readdirSync(pasta).filter(a => a.endsWith('.json')).sort()) {
            const relativo = join('corridas', nome);
            fontes.push({ arquivo: relativo, importar: () => importarCorrida(relativo) });
        }
    }
    return fontes;
}

// JSON quebrado GRITA, como em `lib/estado.mjs`: seguir com o padrão apagaria o estado da pessoa
// por cima do defeito, e aqui apagaria calado o arquivo que ainda é o único backup.
// Arquivo VÁLIDO com a forma errada era importado como zero linha, e a marca selava a fonte para
// sempre: renomear a chave ou salvar o array cru fazia todo o estado sumir em silêncio, com o
// arquivo intacto no disco ao lado. Aceita as duas formas plausíveis e RECUSA o resto — zero linha
// só pode significar "o arquivo está vazio", nunca "eu não entendi o arquivo".
function listaDeclarada(bruto, chave, nome) {
    if (Array.isArray(bruto)) {
        return bruto;
    }
    if (Array.isArray(bruto?.[chave])) {
        return bruto[chave];
    }
    throw new Error(`${nome} não tem a forma esperada: ou um array, ou um objeto com "${chave}": [...]`
        + ` — veio ${bruto === null ? 'null' : Array.isArray(bruto) ? 'array' : typeof bruto}`
        + `${bruto && typeof bruto === 'object' ? ` com as chaves ${Object.keys(bruto).join(', ')}` : ''}`);
}

function lerJson(nome) {
    const caminho = join(caminhoEstado(), nome);
    try {
        return JSON.parse(readFileSync(caminho, 'utf8'));
    } catch (e) {
        throw new Error(`${nome} não é JSON válido e a importação parou aqui (${e.message})`);
    }
}

// Registro que o esquema recusa fica de fora com o motivo na marca, em vez de derrubar a abertura
// inteira — o porquê de recusar em vez de normalizar está no item 5 do cabeçalho.
function importarRegistro(recusados, chave, gravar) {
    try {
        gravar();
        return 1;
    } catch (e) {
        recusados.push(`${chave}: ${e.message.split('\n')[0]}`);
        return 0;
    }
}

function motivoDosRecusados(recusados) {
    if (!recusados.length) {
        return null;
    }
    return `${recusados.length} registro(s) recusados — ${recusados.slice(0, 3).join(' | ')}`;
}

function importarComparacoes() {
    const bruto = lerJson('comparacoes.json');
    const recusados = [];
    let linhas = 0;
    for (const [chave, decisao] of Object.entries(bruto)) {
        const corte = chave.indexOf('|');
        const chamado = corte < 0 ? '?' : chave.slice(0, corte);
        const projeto = corte < 0 ? chave : chave.slice(corte + 1);
        linhas += importarRegistro(recusados, chave, () => decisoes.definir(chamado, projeto, decisao));
    }
    return { linhas, observacao: motivoDosRecusados(recusados) };
}

function importarPontos() {
    const bruto = lerJson('pontos-atencao.json');
    const lista = listaDeclarada(bruto, 'pontos', 'pontos-atencao.json');
    const recusados = [];
    const validos = [];
    for (const ponto of lista) {
        if (SEVERIDADES.includes(ponto?.severidade)) {
            validos.push(ponto);
        } else {
            recusados.push(`${ponto?.id ?? '(sem id)'}: severidade ${JSON.stringify(ponto?.severidade)}`
                + ` fora de ${SEVERIDADES.join('/')}`);
        }
    }
    // O corte do teto é por SEVERIDADE, a mesma regra do descarte de `pontos.gravar`. Por ordem de
    // array, um `atencao` na posição 11 era jogado fora e uma `nota` na 3 sobrevivia.
    const ordenados = validos.sort(compararPontos);
    const cabem = ordenados.slice(0, TETO_PONTOS);
    const fora = ordenados.slice(TETO_PONTOS);
    let linhas = 0;
    for (const ponto of cabem) {
        linhas += importarRegistro(recusados, ponto.id, () => pontos.gravar(ponto));
    }
    const avisos = [
        fora.length
            ? `${fora.length} ponto(s) de menor severidade ficaram fora do teto de ${TETO_PONTOS}:`
                + ` ${fora.map(p => p.id).join(', ')}`
            : null,
        motivoDosRecusados(recusados)
    ].filter(Boolean);
    return { linhas, observacao: avisos.join('; ') || null };
}

// Quem SOBREVIVE ao teto, em ordem: severidade primeiro e, dentro dela, o mais novo. É a inversa
// exata de `_proximoADescartar` — quem sai é o mais antigo da menor severidade, e `atencao` não sai.
function compararPontos(a, b) {
    const peso = ponto => SEVERIDADES.indexOf(ponto.severidade);
    return peso(a) - peso(b)
        || String(b.criadoEm || '').localeCompare(String(a.criadoEm || ''))
        || String(b.id || '').localeCompare(String(a.id || ''));
}

function importarRepos() {
    const bruto = lerJson('repos.json');
    const lista = listaDeclarada(bruto, 'repos', 'repos.json');
    const recusados = [];
    let linhas = 0;
    for (const repo of lista) {
        linhas += importarRegistro(recusados, repo?.projeto ?? '(sem projeto)', () => repos.definir(repo));
    }
    if (bruto?.detectadoEm) {
        repos.marcarDeteccao(bruto.detectadoEm);
    }
    return { linhas, observacao: motivoDosRecusados(recusados) };
}

// As DUAS formas: a corrida chata que o servidor grava e a agrupada que o `exportarJson` produz —
// sem esta, realimentar o próprio export virava uma corrida vazia com o início de agora, calada.
function importarCorrida(relativo) {
    const bruto = lerJson(relativo);
    const lista = Array.isArray(bruto?.corridas)
        ? bruto.corridas.map(corrida => ({ chamado: bruto.chamado, ...corrida }))
        : [bruto];
    const recusados = [];
    let linhas = 0;
    let jaHavia = 0;
    for (const corrida of lista) {
        if (corrida?.chamado && corrida?.inicio && um(
            'SELECT id FROM corridas WHERE chamado = ? AND inicio = ?',
            String(corrida.chamado), corrida.inicio)) {
            jaHavia++;
            continue;
        }
        linhas += importarRegistro(recusados, `${corrida?.chamado ?? relativo}@${corrida?.inicio ?? '?'}`,
            () => corridas.gravar(corrida));
    }
    const avisos = [
        jaHavia ? `${jaHavia} corrida(s) já estavam no banco e não foram reescritas` : null,
        motivoDosRecusados(recusados)
    ].filter(Boolean);
    return { linhas, observacao: avisos.join('; ') || null };
}

// O argumento pró-arquivo era `grep` e editor, e sem saída inspecionável a migração tiraria uma
// capacidade real de quem usa. `paraJson()` é a mesma coisa para quem quer imprimir.
export function paraJson() {
    return {
        banco: caminhoBanco(),
        importacoes: relatorioImportacao(),
        comparacoes: decisoes.mapa(),
        pontosAtencao: { teto: TETO_PONTOS, pontos: pontos.listar() },
        repos: { detectadoEm: repos.detectadoEm(), repos: repos.listar() },
        corridas: corridas.chamados().map(chamado => ({
            chamado,
            corridas: corridas.historico(chamado).map(c => corridas.obter(c.id))
        }))
    };
}

export function exportarJson(destino = join(caminhoEstado(), 'exportado')) {
    const tudo = paraJson();
    mkdirSync(join(destino, 'corridas'), { recursive: true });
    const arquivos = [
        gravarEm(join(destino, 'comparacoes.json'), tudo.comparacoes),
        gravarEm(join(destino, 'pontos-atencao.json'), tudo.pontosAtencao),
        gravarEm(join(destino, 'repos.json'), tudo.repos),
        gravarEm(join(destino, 'importacoes.json'), tudo.importacoes)
    ];
    for (const grupo of tudo.corridas) {
        const nome = `${String(grupo.chamado).replace(/[^A-Za-z0-9-]/g, '')}.json`;
        arquivos.push(gravarEm(join(destino, 'corridas', nome), grupo));
    }
    return { destino, arquivos };
}

function gravarEm(caminho, dados) {
    gravar(caminho, dados);
    return caminho;
}

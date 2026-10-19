// Ponte com o dev.fast Whiteboard pelo comando `whiteboard api`, o mesmo contrato que o agente usa.
// A tela não fala com o app: sem ele aberto, mostra a última leitura guardada na pasta de estado.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { caminhoEstado } from './db.mjs';
import { WORKSPACE } from './diff.mjs';

const execFileAsync = promisify(execFile);
const PADRAO_CHAMADO = /^[A-Z]{2,10}-\d+$/;
const PADRAO_PROJETO = /^[\w.-]+$/;

export const comandoWhiteboard = () => process.env.QUALIDADE_WHITEBOARD
    || join(homedir(), '.local', 'bin', 'whiteboard');

// `UND-23` não pode casar com `UND-2304`: depois do ID, no título, não pode vir outro dígito.
const tituloDoChamado = (titulo, id) => {
    const t = String(titulo || '').toUpperCase();
    return t.startsWith(id) && !/\d/.test(t.charAt(id.length));
};

// O do repo aberto primeiro; sem ele, o mais recente do chamado em outro repo: chamado de 5 repos tem um quadro só.
export function escolherQuadro(sessoes, { chamado, projeto }) {
    const id = String(chamado || '').toUpperCase();
    const doChamado = s => String(s.origin?.branch || '').toUpperCase() === id || tituloDoChamado(s.title, id);
    const doProjeto = s => s.repositoryName === projeto || basename(s.repositoryPath || '') === projeto;
    const candidatos = (Array.isArray(sessoes) ? sessoes : [])
        .filter(s => !s.trashedAt && doChamado(s))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return candidatos.find(doProjeto) || candidatos[0] || null;
}

function classificar(erro) {
    if (erro.code === 'ENOENT') {
        return 'sem-comando';
    }
    const texto = `${erro.stdout || ''}${erro.stderr || ''}${erro.message || ''}`;
    return /not running|No Whiteboard is running/i.test(texto) ? 'app-fechado' : 'erro';
}

async function chamar(ferramenta, entrada) {
    const { stdout } = await execFileAsync(comandoWhiteboard(), ['api', ferramenta, JSON.stringify(entrada)],
        { timeout: 15000, maxBuffer: 32 * 1024 * 1024 });
    try {
        return JSON.parse(stdout);
    } catch {
        throw Object.assign(new Error(stdout.trim().slice(0, 300) || 'resposta vazia'), { stdout });
    }
}

const ANCORA = /^(head|base)\/(.+?)#L(\d+)(?:-L?(\d+))?$/;
const TETO_DE_LINHAS = 200;
// Commit não muda de repo: o dono achado vale pelo resto do processo. Não achado não fica, o fetch pode trazer.
const DONO_DO_COMMIT = new Map();

function trechosDo(no, achados = []) {
    if (Array.isArray(no)) {
        no.forEach(n => trechosDo(n, achados));
    } else if (no && typeof no === 'object') {
        if (no.type === 'code_peek') {
            achados.push(no);
        }
        Object.values(no).forEach(v => trechosDo(v, achados));
    }
    return achados;
}

// O código de cada trecho, do commit a que o quadro está preso. O repo é o que TEM o commit: o quadro
// cita outros repos por um id do Whiteboard, e mapear esse id exigiria registrar repo no app.
export async function anexarTrechos(quadro, raizDoQuadro, { workspace = WORKSPACE } = {}) {
    const git = (raiz, args) => execFileAsync('git', ['-C', raiz, ...args], { maxBuffer: 16 * 1024 * 1024 })
        .then(r => r.stdout, () => null);
    const donoDo = async sha => {
        if (!DONO_DO_COMMIT.has(sha)) {
            const candidatos = [raizDoQuadro, ...readdirSync(workspace).map(n => join(workspace, n))]
                .filter(p => p && existsSync(join(p, '.git')));
            DONO_DO_COMMIT.set(sha, Promise.all(candidatos.map(r => git(r, ['cat-file', '-e', `${sha}^{commit}`])))
                .then(achou => candidatos[achou.findIndex(saida => saida !== null)] || null));
        }
        const dono = await DONO_DO_COMMIT.get(sha);
        if (!dono) {
            DONO_DO_COMMIT.delete(sha);
        }
        return dono;
    };
    const arquivos = new Map();
    for (const peek of trechosDo(quadro?.document)) {
        const m = ANCORA.exec(peek.source || '');
        const pins = peek.pins || quadro.pins || {};
        const sha = m && (m[1] === 'base' ? pins.base : pins.head);
        if (!sha) {
            continue;
        }
        const raiz = await donoDo(sha);
        if (!raiz) {
            peek.trecho = { erro: `o commit ${sha.slice(0, 8)} não está em nenhum repo deste workspace` };
            continue;
        }
        const chave = `${raiz}:${sha}:${m[2]}`;
        if (!arquivos.has(chave)) {
            arquivos.set(chave, git(raiz, ['show', `${sha}:${m[2]}`]));
        }
        const texto = await arquivos.get(chave);
        if (texto === null) {
            peek.trecho = { erro: `${m[2]} não existe em ${sha.slice(0, 8)}` };
            continue;
        }
        const linhas = texto.split('\n');
        const inicio = Number(m[3]);
        const fim = Math.min(Number(m[4] || m[3]), linhas.length, inicio + TETO_DE_LINHAS - 1);
        peek.trecho = { repo: basename(raiz), commit: sha.slice(0, 8), inicio, fim, total: linhas.length, linhas: linhas.slice(inicio - 1, fim) };
    }
    return quadro;
}

const arquivoGuardado = (chamado, projeto) => join(caminhoEstado(), 'whiteboards', `${chamado}--${projeto}.json`);

function guardar(chamado, projeto, lido) {
    try {
        mkdirSync(join(caminhoEstado(), 'whiteboards'), { recursive: true });
        writeFileSync(arquivoGuardado(chamado, projeto), JSON.stringify(lido));
    } catch {
        // Sem cópia guardada a aba só perde o modo "app fechado"; a leitura ao vivo segue valendo.
    }
}

function recuperar(chamado, projeto) {
    try {
        return JSON.parse(readFileSync(arquivoGuardado(chamado, projeto), 'utf8'));
    } catch {
        return null;
    }
}

export async function lerQuadro({ chamado, projeto }) {
    const id = String(chamado || '').toUpperCase();
    if (!PADRAO_CHAMADO.test(id) || !PADRAO_PROJETO.test(String(projeto || ''))) {
        return { estado: 'sem-quadro' };
    }
    try {
        const escolhido = escolherQuadro(await chamar('session_list', {}), { chamado: id, projeto });
        if (!escolhido) {
            return { estado: 'sem-quadro' };
        }
        const quadro = await anexarTrechos(
            await chamar('session_get', { sessionId: escolhido.sessionId, format: 'json', full: true }), escolhido.repositoryPath);
        const lido = { lidoEm: new Date().toISOString(), repo: escolhido.repositoryName || basename(escolhido.repositoryPath || ''), quadro };
        guardar(id, projeto, lido);
        return { estado: 'ao-vivo', ...lido };
    } catch (erro) {
        const estado = classificar(erro);
        const guardado = recuperar(id, projeto);
        return guardado ? { estado, ...guardado } : { estado, erro: estado === 'erro' ? erro.message : null };
    }
}

// Sem `sessao`, só sobe o app em segundo plano; com ela, abre aquele quadro na frente.
export async function abrirNoApp(sessao) {
    const opcoes = { timeout: 30000 };
    await execFileAsync(comandoWhiteboard(), ['app', 'launch'], opcoes);
    if (sessao) {
        await execFileAsync(comandoWhiteboard(), ['app', 'pick', '--session', sessao, '--focus'], opcoes);
    }
}

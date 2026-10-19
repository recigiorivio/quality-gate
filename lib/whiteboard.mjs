// Ponte com o dev.fast Whiteboard pelo comando `whiteboard api`, o mesmo contrato que o agente usa.
// A tela não fala com o app: sem ele aberto, mostra a última leitura guardada na pasta de estado.
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { caminhoEstado } from './db.mjs';

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

export function escolherQuadro(sessoes, { chamado, projeto }) {
    const id = String(chamado || '').toUpperCase();
    const doChamado = s => String(s.origin?.branch || '').toUpperCase() === id || tituloDoChamado(s.title, id);
    const doProjeto = s => s.repositoryName === projeto || basename(s.repositoryPath || '') === projeto;
    return (Array.isArray(sessoes) ? sessoes : [])
        .filter(s => !s.trashedAt && doChamado(s) && doProjeto(s))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
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
        const quadro = await chamar('session_get', { sessionId: escolhido.sessionId, format: 'json', full: true });
        const lido = { lidoEm: new Date().toISOString(), quadro };
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

// Quais sessões do Claude Code estão abertas nesta máquina, e o que cada uma está fazendo.
//
// ⚠️ "sessão" aqui NÃO é o `agente` do resto do projeto. `/api/agente`, `estadoAgente` e
// `painelAgente` são o agente que a própria tela dispara para decidir comparação e implantação.
// Isto é outra coisa: os Claude Code que VOCÊ abriu, em qualquer pasta. Os nomes ficaram separados
// porque `/api/agentes` e `/api/agente` são a mesma rota para quem lê rápido.
//
// A fonte é `~/.claude/sessions/<pid>.json`, o mesmo registro que `claude agents --json` lê. Medido
// nesta máquina: o comando custa 170 ms por chamada e a leitura direta 0,05 ms — 3.200× mais barata,
// e o contador da barra reconsulta sozinho. O preço é acoplar a um formato interno da CLI; por isso
// todo campo é opcional aqui, e o que falta vira ausência na tela, não erro.
//
// Dois passos, como o `implantacao.mjs`: `resumo()` conta e diz quem está ocupado; `detalhe()` abre
// os transcripts e é o caro — sai só quando a modal pede.

import { readdirSync, readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Buffer } from 'node:buffer';
import { WORKSPACE } from './diff.mjs';

export class Sessoes {
    // `QUALIDADE_CLAUDE_HOME` existe pelo mesmo motivo do `QUALIDADE_ESTADO`: sem ele o teste de
    // tela só veria o que a máquina por acaso rodasse, e caso que depende de acaso não é caso.
    static casa() {
        return process.env.QUALIDADE_CLAUDE_HOME || join(homedir(), '.claude');
    }

    constructor(registro = join(Sessoes.casa(), 'sessions'),
        projetos = join(Sessoes.casa(), 'projects')) {
        this.registro = registro;
        this.projetos = projetos;
        this.tetoBytes = 256 * 1024;
        this.tetoTotal = 4 * 1024 * 1024;
        this.tetoTexto = 400;
        this.tetoFerramenta = 140;
    }

    resumo() {
        const sessoes = this.registradas();
        return {
            total: sessoes.length,
            ocupadas: sessoes.filter(s => s.status === 'busy').length,
            paradas: sessoes.filter(s => s.status && s.status !== 'busy').length,
            // CLI antiga não grava `status`: contar como parada seria afirmar o que não se sabe.
            mudas: sessoes.filter(s => !s.status).length,
            sessoes
        };
    }

    detalhe() {
        const r = this.resumo();
        // Forma constante: sessão de IDE/SDK não grava transcript, e devolver um objeto SEM os
        // campos faria o cliente ler ausência de arquivo como ausência de atividade.
        r.sessoes = r.sessoes.map(s => {
            const transcript = this.transcript(s.sessionId);
            const vazio = { pedido: null, ferramenta: null, fala: null, quando: null, truncado: false };
            return { ...s, transcript, ...(transcript ? this.atividade(transcript) : vazio) };
        });
        return r;
    }

    registradas() {
        if (!existsSync(this.registro)) {
            return [];
        }
        return readdirSync(this.registro)
            .filter(f => f.endsWith('.json'))
            .map(f => this.lerJson(join(this.registro, f)))
            .filter(s => s?.pid && s.sessionId && this.viva(s.pid))
            .map(s => ({
                pid: s.pid,
                sessionId: s.sessionId,
                nome: s.nome || s.name || `pid ${s.pid}`,
                cwd: s.cwd || '',
                tipo: s.kind || '',
                status: s.status || null,
                inicio: s.startedAt || null,
                versao: s.version || '',
                daqui: Boolean(s.cwd && s.cwd.startsWith(WORKSPACE))
            }))
            .sort((a, b) => Number(b.daqui) - Number(a.daqui)
                || Number(b.status === 'busy') - Number(a.status === 'busy')
                || (b.inicio || 0) - (a.inicio || 0));
    }

    // `kill(pid, 0)` não mata, pergunta — e EPERM é processo VIVO de outro dono. Só ESRCH é morto.
    viva(pid) {
        try {
            process.kill(pid, 0);
            return true;
        } catch (erro) {
            return erro.code === 'EPERM';
        }
    }

    // O slug de projeto é o caminho com `/` virando `-`, o que colide com pasta que já tem hífen.
    transcript(sessionId) {
        if (!existsSync(this.projetos)) {
            return null;
        }
        for (const projeto of readdirSync(this.projetos)) {
            const arquivo = join(this.projetos, projeto, `${sessionId}.jsonl`);
            if (existsSync(arquivo)) {
                return arquivo;
            }
        }
        return null;
    }

    // Anda para trás até achar o pedido: numa sessão que trabalhou muito ele fica longe do fim.
    // Não achar é resposta legítima, e `truncado` a separa de não ter procurado o bastante.
    atividade(arquivo) {
        const visto = { pedido: null, ferramenta: null, fala: null, quando: null, truncado: false };
        let tamanho = 0;
        try {
            tamanho = statSync(arquivo).size;
        } catch {
            return visto;
        }
        let fim = tamanho;
        let lido = 0;
        while (fim > 0 && lido < this.tetoTotal && !visto.pedido) {
            const quanto = Math.min(fim, this.tetoBytes);
            const local = this.varrer(this.pedaco(arquivo, fim - quanto, quanto, fim - quanto > 0));
            for (const campo of ['pedido', 'ferramenta', 'fala', 'quando']) {
                if (visto[campo] === null) {
                    visto[campo] = local[campo];
                }
            }
            fim -= quanto;
            lido += quanto;
        }
        visto.truncado = !visto.pedido && fim > 0;
        return visto;
    }

    varrer(linhas) {
        const visto = { pedido: null, ferramenta: null, fala: null, quando: null };
        for (const linha of linhas) {
            const d = this.lerLinha(linha);
            if (!d || d.isSidechain) {
                continue;
            }
            if (d.timestamp) {
                visto.quando = d.timestamp;
            }
            for (const bloco of this.blocos(d)) {
                this.anotar(visto, d.type, bloco);
            }
        }
        return visto;
    }

    // Transcript chega a megabytes: lê por descritor, nunca o arquivo inteiro.
    pedaco(arquivo, de, quanto, cortado) {
        let fd;
        try {
            const buffer = Buffer.alloc(quanto);
            fd = openSync(arquivo, 'r');
            readSync(fd, buffer, 0, quanto, de);
            const linhas = buffer.toString('utf8').split('\n');
            // A primeira linha do pedaço começou antes do corte e chegou pela metade.
            return cortado ? linhas.slice(1) : linhas;
        } catch {
            return [];
        } finally {
            if (fd !== undefined) {
                closeSync(fd);
            }
        }
    }

    anotar(visto, tipo, bloco) {
        // Prompt do usuário vem junto com system-reminder e saída de comando, todos abrindo em `<`.
        if (tipo === 'user' && bloco.type === 'text' && !bloco.text.startsWith('<')) {
            visto.pedido = this.cortar(bloco.text);
        }
        if (tipo !== 'assistant') {
            return;
        }
        if (bloco.type === 'tool_use') {
            visto.ferramenta = { nome: bloco.name, entrada: this.cortar(JSON.stringify(bloco.input || {}), this.tetoFerramenta) };
        }
        if (bloco.type === 'text' && bloco.text.trim()) {
            visto.fala = this.cortar(bloco.text);
        }
    }

    blocos(d) {
        const conteudo = d.message?.content;
        if (Array.isArray(conteudo)) {
            return conteudo;
        }
        return typeof conteudo === 'string' ? [{ type: 'text', text: conteudo }] : [];
    }

    // Transcript chega a 5,6 MB nesta máquina: lê a cauda por descritor, nunca o arquivo inteiro.
    cauda(arquivo) {
        let fd;
        try {
            const tamanho = statSync(arquivo).size;
            const quanto = Math.min(tamanho, this.tetoBytes);
            const buffer = Buffer.alloc(quanto);
            fd = openSync(arquivo, 'r');
            readSync(fd, buffer, 0, quanto, tamanho - quanto);
            const linhas = buffer.toString('utf8').split('\n');
            // A primeira linha do pedaço quase sempre começou antes do corte e está pela metade.
            return quanto < tamanho ? linhas.slice(1) : linhas;
        } catch {
            return [];
        } finally {
            if (fd !== undefined) {
                closeSync(fd);
            }
        }
    }

    lerJson(caminho) {
        try {
            return JSON.parse(readFileSync(caminho, 'utf8'));
        } catch {
            return null;
        }
    }

    lerLinha(linha) {
        try {
            return JSON.parse(linha);
        } catch {
            return null;
        }
    }

    cortar(texto, teto = this.tetoTexto) {
        const limpo = String(texto).replace(/\s+/g, ' ').trim();
        return limpo.length > teto ? `${limpo.slice(0, teto)}…` : limpo;
    }
}

// Resolve a casa a CADA chamada: o módulo é importado antes de o teste ajustar a env.
export default {
    resumo: () => new Sessoes().resumo(),
    detalhe: () => new Sessoes().detalhe()
};

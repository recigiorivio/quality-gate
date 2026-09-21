// Gate de qualidade acoplado a ações que não dá para pular: commit, abertura e merge de PR.
// Rotina que depende de alguém lembrar de acionar não é acionada — três tentativas já provaram isso
// nesta base. Aqui o ponto de cobrança é a ação, não o momento.
//
// Falha aberto de propósito: qualquer erro interno libera a ação. Um gate quebrado que trava o
// trabalho é desinstalado no mesmo dia, e aí não sobra gate nenhum.

import { execFileSync } from 'node:child_process';
import { existsSync, appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { WORKSPACE } from '../lib/diff.mjs';
import { ROTINA_FIM } from '../lib/configs.mjs';


// Deduzido de onde ESTE arquivo está, nunca do nome da pasta: `join(WORKSPACE, 'qualidade')` só
// acertava em quem clonou com esse nome, e errava calado em qualquer outro clone.
const PROJETO = dirname(dirname(fileURLToPath(import.meta.url)));
const FERRAMENTAS = join(PROJETO, 'ferramentas');
const PORTA_TELA = Number(process.env.QUALIDADE_PORTA || 4100);
const LOG = join(PROJETO, 'gate.log');
const PADRAO_CHAMADO = /\b([A-Z]{2,5}-\d{2,5})\b/;

class Gate {
    constructor(evento, payload) {
        this.evento = evento;
        this.payload = payload;
    }

    registrar(acao, resultado, detalhe = '') {
        try {
            appendFileSync(LOG, `${new Date().toISOString()}\t${acao}\t${resultado}\t${detalhe.replace(/\s+/g, ' ').slice(0, 300)}\n`);
        } catch {
            // log é observabilidade, não pode derrubar o gate
        }
    }

    liberar() {
        process.exit(0);
    }

    injetar(texto) {
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'UserPromptSubmit',
                additionalContext: texto
            }
        }));
        process.exit(0);
    }

    rodar(args, cwd = WORKSPACE) {
        try {
            const saida = execFileSync('node', args, { cwd, encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'] });
            return { codigo: 0, saida };
        } catch (e) {
            return { codigo: e.status ?? 1, saida: `${e.stdout || ''}${e.stderr || ''}` };
        }
    }

    // O projeto vem do -C do comando, senão do cwd da sessão. Sem isso o gate checa o repo errado.
    projetoDo(comando, cwd) {
        const viaC = comando.match(/git\s+(?:-c\s+\S+\s+)*-C\s+(\S+)/);
        const alvo = viaC ? join(cwd || WORKSPACE, viaC[1].replace(/^["']|["']$/g, '')) : (cwd || WORKSPACE);
        try {
            const raiz = execFileSync('git', ['-C', alvo, 'rev-parse', '--show-toplevel'],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
            return raiz.startsWith(WORKSPACE) ? (raiz.slice(WORKSPACE.length + 1) || '.') : null;
        } catch {
            return null;
        }
    }

    // O relatório é temporário de propósito: vive em /tmp e os de mais de um dia são apagados.
    // Diff antigo acumulado no workspace só serve para você abrir o arquivo errado.
    _limparAntigos(dir) {
        const limite = Date.now() - 24 * 60 * 60 * 1000;
        try {
            for (const nome of readdirSync(dir)) {
                if (!nome.startsWith('diff-') || !nome.endsWith('.html')) {
                    continue;
                }
                const alvo = join(dir, nome);
                if (statSync(alvo).mtimeMs < limite) {
                    rmSync(alvo, { force: true });
                }
            }
        } catch {
            // limpeza é higiene, não pode derrubar o gate
        }
    }

    // Se a tela local está no ar, o link basta e não sobra arquivo nenhum. Só cai para o HTML
    // temporário quando o servidor não está rodando.
    _telaNoAr() {
        try {
            execFileSync('nc', ['-z', '127.0.0.1', String(PORTA_TELA)], { timeout: 1500, stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    }

    gerarDiff(comando, cwd) {
        const projeto = this.projetoDo(comando, cwd);
        if (!projeto || projeto === '.' || projeto === 'qualidade') {
            this.liberar();
        }
        if (this._telaNoAr()) {
            this.registrar('diff', 'tela', projeto);
            process.stdout.write(`Conferência e diff deste chamado: http://localhost:${PORTA_TELA}/ (repo ${projeto})\n`);
            this.liberar();
        }
        const dir = join(tmpdir(), 'qualidade-diff');
        try {
            mkdirSync(dir, { recursive: true });
        } catch {
            this.liberar();
        }
        this._limparAntigos(dir);
        const r = this.rodar([join(FERRAMENTAS, 'diff-visao.mjs'), projeto, '-', dir]);
        const caminho = (r.saida.match(/^.*\.html$/m) || [])[0];
        this.registrar('diff', caminho ? 'html' : 'falhou', `${projeto} ${caminho || r.saida.slice(0, 120)}`);
        if (caminho) {
            process.stdout.write(`Relatório de diff (temporário, 24h): ${caminho}\n` +
                `Ou suba a tela: cd qualidade && npm start\n`);
        }
        this.liberar();
    }

    // Depois do commit o diff mudou: derruba o cache do projeto, e a tela aberta recarrega sozinha
    // pelo canal de eventos. Sem isso ela mostraria o estado de antes do commit.
    tratarPostToolUse() {
        const comando = this.payload?.tool_input?.command;
        // `add` entrou porque o passo 1.0 da rotina de fim põe em stage, e stage muda o diff: arquivo
        // `??` que passa a ser rastreado só aparece na tela depois disso.
        if (typeof comando !== 'string' || !/\bgit\b[^|;&]*\b(commit|merge|rebase|checkout|switch|reset|add|stash|restore)\b/.test(comando)) {
            this.liberar();
        }
        const projeto = this.projetoDo(comando, this.payload?.cwd);
        if (!projeto || !this._telaNoAr()) {
            this.liberar();
        }
        try {
            execFileSync('curl', ['-s', '-m', '3',
                `http://127.0.0.1:${PORTA_TELA}/api/invalidar?projeto=${encodeURIComponent(projeto)}`],
                { stdio: 'ignore' });
            this.registrar('invalidar', 'ok', projeto);
        } catch {
            this.registrar('invalidar', 'falhou', projeto);
        }
        this.liberar();
    }

    tratarPreToolUse() {
        const comando = this.payload?.tool_input?.command;
        if (typeof comando !== 'string') {
            this.liberar();
        }
        const cwd = this.payload?.cwd;
        if (/\bgit\b[^|;&]*\bcommit\b/.test(comando) || /\bgh\s+pr\s+create\b/.test(comando)) {
            this.gerarDiff(comando, cwd);
        }
        this.liberar();
    }

    // Injeta o conteúdo da rotina, não um ponteiro para ela. Ponteiro ainda depende de decidir
    // abrir o arquivo — e é aí que as três tentativas anteriores morreram.
    // Recebe o caminho relativo do `CONFIGS`, não o nome do arquivo: saber `.claude/commands` aqui
    // TAMBÉM deixava dois lugares para divergir, e o que fica errado é o que ninguém lê.
    _injetarRotina(relativo, cabecalho, chave) {
        const caminho = join(WORKSPACE, relativo);
        if (!existsSync(caminho)) {
            this.liberar();
        }
        const marca = join(tmpdir(), `qualidade-${chave}-${new Date().toISOString().slice(0, 10)}`);
        if (existsSync(marca)) {
            this.liberar();
        }
        try {
            appendFileSync(marca, '1');
        } catch {
            // sem marca o aviso repete; melhor repetir do que travar
        }
        const corpo = readFileSync(caminho, 'utf8').replace(/^---[\s\S]*?---\n/, '');
        this.registrar('prompt', 'rotina-injetada', chave);
        this.injetar(`${cabecalho}\n\n${corpo}`);
    }

    tratarPrompt() {
        // Corrida disparada pela tela: o prompt dela é uma tarefa fechada de um chamado só, e
        // injetar a rotina de fim inteira fazia o agente considerar coisa que não foi pedida.
        if (process.env.QUALIDADE_AGENTE) {
            this.registrar('prompt', 'sem-injecao', `agente ${process.env.QUALIDADE_AGENTE}`);
            return this.liberar();
        }
        const prompt = this.payload?.prompt || '';
        const chamado = (prompt.match(PADRAO_CHAMADO) || [])[1];   // só para separar o dedup por chamado
        const fimDeTrabalho = /\b(commit|comita|comitar|push|pr|merge|mescla|mesclar|finaliza|finalizar|fechar o chamado|abrir o pr|subir|entregar)\b/i.test(prompt);

        if (fimDeTrabalho) {
            this._injetarRotina(
                ROTINA_FIM,
                'O usuário sinalizou fim de trabalho. A rotina de fim deste workspace é a abaixo — seguir os passos que se aplicam, dizer quais não se aplicam, e não commitar/empurrar/mesclar sem confirmação explícita.',
                `final${chamado ? `-${chamado}` : ''}`
            );
        }
        this.liberar();
    }

    executar() {
        if (this.evento === 'pretooluse') {
            this.tratarPreToolUse();
        }
        if (this.evento === 'posttooluse') {
            this.tratarPostToolUse();
        }
        if (this.evento === 'prompt') {
            this.tratarPrompt();
        }
        this.liberar();
    }
}

let bruto = '';
process.stdin.on('data', d => {
    bruto += d;
});
process.stdin.on('end', () => {
    try {
        new Gate(process.argv[2], JSON.parse(bruto || '{}')).executar();
    } catch {
        process.exit(0);
    }
});
setTimeout(() => process.exit(0), 10000);

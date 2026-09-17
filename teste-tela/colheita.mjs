// Colhe servidor de teste órfão antes de começar.
//
// A fixture mata o servidor no `finally`, mas `finally` não roda quando o processo do runner
// morre por SIGKILL — Ctrl-C forte, timeout de agente, `pkill -9`. O filho sobrevive com `ppid=1`,
// segurando porta, arquivo e CPU. Medido depois de algumas rodadas interrompidas: dois servidores
// órfãos vivos e carga 5,8 na máquina, com a suíte falhando por tempo esgotado em casos que
// passavam sozinhos. Falha por carga é indistinguível de falha por defeito, e foi o que me fez
// perseguir um bug que não existia.
//
// O critério é estreito de propósito: só morre servidor deste projeto cujo estado aponta para um
// diretório TEMPORÁRIO. O servidor de trabalho usa o estado da raiz e nunca casa — matá-lo seria
// derrubar a tela de quem está usando a ferramenta.
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const TEMP = tmpdir().replace(/\/$/, '');

function saida(comando, ...args) {
    try {
        return execFileSync(comando, args, { encoding: 'utf8' });
    } catch {
        return '';
    }
}

export default function colher() {
    const pids = saida('pgrep', '-f', 'server\\.mjs').trim().split('\n').filter(Boolean);
    const mortos = [];
    for (const pid of pids) {
        // `ps eww` mostra o ambiente do processo: é como se descobre para onde o estado dele aponta
        // sem depender de o comando trazer isso na linha.
        const ambiente = saida('ps', 'eww', '-p', pid);
        const estado = ambiente.match(/QUALIDADE_ESTADO=(\S+)/)?.[1];
        const pai = saida('ps', '-o', 'ppid=', '-p', pid).trim();
        if (!estado || !estado.startsWith(TEMP) || pai !== '1') {
            continue;
        }
        try {
            process.kill(Number(pid), 'SIGTERM');
            mortos.push(pid);
        } catch {
            // já saiu entre a listagem e o sinal
        }
    }
    if (mortos.length) {
        console.log(`colheita: ${mortos.length} servidor(es) de teste órfão(s) encerrado(s): ${mortos.join(', ')}`);
    }
}

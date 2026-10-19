// Aviso do sistema, com som, quando o mago ou o juiz termina: são minutos de corrida, e a tela costuma
// estar atrás de outra janela. No servidor e não na página: o navegador bloqueia som sem clique recente.
import { execFile } from 'node:child_process';

const TITULOS = { agente: '🧙 O mago terminou', juiz: '⚖️ The Judge terminou' };

// Título e texto vão como argumentos do script, nunca dentro dele: texto do agente não vira AppleScript.
const SCRIPT = ['-e', 'on run argv',
    '-e', 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"',
    '-e', 'end run'];

export function avisoDoSistema(evento, {
    plataforma = process.platform,
    desligado = Boolean(process.env.QUALIDADE_SEM_AVISO_DO_SISTEMA),
    rodar = execFile
} = {}) {
    if (desligado || evento?.fase !== 'fim' || !TITULOS[evento.tipo] || plataforma !== 'darwin') {
        return null;
    }
    const resultado = evento.veredito || (evento.ok === false ? 'com erro' : null);
    const corpo = [evento.chamado, evento.projeto, resultado, evento.texto].filter(Boolean).join(' · ').slice(0, 200);
    const args = [...SCRIPT, TITULOS[evento.tipo], corpo];
    rodar('osascript', args, () => { /* sem permissão de notificação, a corrida segue igual */ });
    return { titulo: TITULOS[evento.tipo], corpo, args };
}

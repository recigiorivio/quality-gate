// Lê o gate.log. Existia quem escrevesse e ninguém que lesse — e log que ninguém lê não é
// observabilidade, é arquivo crescendo. A pergunta que isto responde: em um mês, isto pegou algo ou
// virou paisagem?
//
// uso: node qualidade/ferramentas/log.mjs [--dias=30] [--json]

import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ARQUIVO = join(dirname(dirname(fileURLToPath(import.meta.url))), 'gate.log');

export class Log {
    ler(dias) {
        if (!existsSync(ARQUIVO)) {
            return { existe: false, linhas: [] };
        }
        const corte = dias ? Date.now() - dias * 86400000 : 0;
        const linhas = readFileSync(ARQUIVO, 'utf8').split('\n').filter(Boolean).map(l => {
            const [quando, acao, resultado, ...resto] = l.split('\t');
            return { quando, acao, resultado, detalhe: resto.join('\t') };
        }).filter(x => !corte || new Date(x.quando).getTime() >= corte);
        return { existe: true, bytes: statSync(ARQUIVO).size, linhas };
    }

    resumir(dias) {
        const { existe, bytes, linhas } = this.ler(dias);
        if (!existe) {
            return { existe: false };
        }
        const porAcao = {};
        const porResultado = {};
        const projetos = {};
        for (const l of linhas) {
            porAcao[l.acao] = (porAcao[l.acao] || 0) + 1;
            const chave = `${l.acao}/${l.resultado}`;
            porResultado[chave] = (porResultado[chave] || 0) + 1;
            const projeto = (l.detalhe || '').split(/[:\s]/)[0];
            if (projeto && !projeto.startsWith('{')) {
                projetos[projeto] = (projetos[projeto] || 0) + 1;
            }
        }
        const datas = linhas.map(l => l.quando).filter(Boolean).sort();
        return {
            existe: true,
            bytes,
            disparos: linhas.length,
            de: datas[0] || null,
            ate: datas[datas.length - 1] || null,
            porAcao,
            porResultado,
            projetos: Object.entries(projetos).sort((a, b) => b[1] - a[1]).slice(0, 8)
        };
    }
}

const args = process.argv.slice(2);
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const dias = Number((args.find(a => a.startsWith('--dias=')) || '').split('=')[1]) || 0;
    const r = new Log().resumir(dias);
    if (args.includes('--json')) {
        process.stdout.write(JSON.stringify(r));
    } else if (!r.existe) {
        console.log('gate.log não existe: o hook nunca disparou (ou não está registrado).');
    } else if (!r.disparos) {
        console.log(`gate.log tem ${r.bytes} bytes, mas nenhum disparo${dias ? ` nos últimos ${dias} dia(s)` : ''}.`);
    } else {
        const janela = dias ? `últimos ${dias} dia(s)` : 'desde o início';
        console.log(`${r.disparos} disparo(s) · ${janela} · ${r.de?.slice(0, 10)} → ${r.ate?.slice(0, 10)} · ${r.bytes} bytes\n`);
        console.log('por ação');
        for (const [k, n] of Object.entries(r.porAcao).sort((a, b) => b[1] - a[1])) {
            console.log(`  ${String(n).padStart(5)}  ${k}`);
        }
        console.log('\npor resultado');
        for (const [k, n] of Object.entries(r.porResultado).sort((a, b) => b[1] - a[1])) {
            console.log(`  ${String(n).padStart(5)}  ${k}`);
        }
        if (r.projetos.length) {
            console.log('\nprojetos mais tocados');
            for (const [k, n] of r.projetos) {
                console.log(`  ${String(n).padStart(5)}  ${k}`);
            }
        }
        // A pergunta que o log existe para responder.
        const barrados = Object.entries(r.porResultado)
            .filter(([k]) => /BARRADO|removido|corrigido/i.test(k))
            .reduce((s, [, n]) => s + n, 0);
        console.log(`\n${barrados
            ? `${barrados} disparo(s) mudaram algo. Está pegando coisa.`
            : 'Nenhum disparo mudou nada. Se isso persistir por semanas, o hook virou paisagem — considere desligar.'}`);
    }
}

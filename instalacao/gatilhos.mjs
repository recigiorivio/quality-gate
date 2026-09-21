// Liga e desliga os gatilhos deste clone no `.claude/settings.json` do workspace.
//
// Existe porque a instalação até aqui entregava os arquivos e deixava o acionamento por conta de
// alguém lembrar de editar um JSON à mão — e rotina que depende de lembrar não é acionada. O par
// `--remove` não é cortesia: a partir do momento em que a instalação escreve, instalação sem
// desinstalação deixa lixo que ninguém sabe de onde veio.
//
// Não roda nada sozinho: `--add` e `--remove` mostram o que vão fazer e esperam confirmação.
import { createInterface } from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE } from '../lib/diff.mjs';
import {
    caminhoSettings, lerSettings, gravarSettings, comGatilhos, semGatilhos,
    jaRegistrados, outrosClones, plantados, removerPlantados, EVENTOS
} from '../lib/gatilhos.mjs';

const PROJETO = dirname(dirname(fileURLToPath(import.meta.url)));
const SETTINGS = caminhoSettings(WORKSPACE);
const args = new Set(process.argv.slice(2));

function curto(caminho) {
    const r = relative(WORKSPACE, caminho);
    return r.startsWith('..') ? caminho : r;
}

function status(settings) {
    const meus = jaRegistrados(settings, PROJETO);
    const outros = outrosClones(settings, PROJETO);
    const md = plantados(WORKSPACE);
    console.log(`workspace   ${WORKSPACE}`);
    console.log(`clone       ${PROJETO}`);
    console.log(`settings    ${existsSync(SETTINGS) ? curto(SETTINGS) : `${curto(SETTINGS)} (não existe ainda)`}`);
    console.log(`\ngatilhos deste clone   ${meus.length ? meus.join(', ') : 'nenhum'}`);
    for (const o of outros) {
        console.log(`  ⚠ também registrado: ${o}  → a rotina vai chegar duas vezes`);
    }
    console.log(`rotinas plantadas      ${md.length ? md.map(c => curto(c.absoluto)).join(', ') : 'nenhuma'}`);
    return { meus, outros, md };
}

async function confirmar(pergunta) {
    if (args.has('--sim')) {
        return true;
    }
    const io = createInterface({ input: process.stdin, output: process.stdout });
    const r = await io.question(`${pergunta} [s/N] `);
    io.close();
    return /^s/i.test(r.trim());
}

async function adicionar(settings) {
    const faltando = EVENTOS.filter(e => !jaRegistrados(settings, PROJETO).includes(e.evento));
    if (!faltando.length) {
        console.log('\nnada a fazer: os três gatilhos deste clone já estão registrados');
        return 0;
    }
    console.log(`\nvai acrescentar em ${curto(SETTINGS)}:`);
    for (const { evento, argumento } of faltando) {
        console.log(`  ${evento.padEnd(17)} → node ${join(PROJETO, 'hook/gate.mjs')} ${argumento}`);
    }
    if (!await confirmar('confirmar?')) {
        console.log('nada gravado');
        return 0;
    }
    const backup = gravarSettings(SETTINGS, comGatilhos(settings, PROJETO));
    console.log(`gravado${backup ? ` · backup em ${curto(backup)}` : ''}`);
    console.log('⚠ hook novo só vale na PRÓXIMA sessão do Claude Code — a atual já leu o settings');
    return 0;
}

async function remover(settings) {
    const { meus, md } = status(settings);
    if (!meus.length && !md.length) {
        console.log('\nnada a remover deste clone');
        return 0;
    }
    console.log('\nvai remover:');
    for (const evento of meus) {
        console.log(`  gatilho ${evento}`);
    }
    for (const c of md) {
        console.log(`  rotina  ${curto(c.absoluto)}  (guarda .bak antes de apagar)`);
    }
    if (!await confirmar('confirmar?')) {
        console.log('nada removido');
        return 0;
    }
    if (meus.length) {
        const backup = gravarSettings(SETTINGS, semGatilhos(settings, PROJETO));
        console.log(`settings limpo${backup ? ` · backup em ${curto(backup)}` : ''}`);
    }
    for (const rel of removerPlantados(WORKSPACE)) {
        console.log(`removido ${rel} (cópia em ${rel}.bak)`);
    }
    console.log(`\nfalta só o que mora fora do workspace, e é seu para decidir:`);
    console.log('  rm -rf ~/.claude/skills/instalar-quality-gate');
    console.log(`  rm -rf ${PROJETO}`);
    return 0;
}

const { settings } = lerSettings(SETTINGS);
let saida = 0;
if (args.has('--add')) {
    status(settings);
    saida = await adicionar(settings);
} else if (args.has('--remove')) {
    saida = await remover(settings);
} else {
    status(settings);
    console.log('\n--add para registrar, --remove para desfazer (--sim pula a confirmação)');
}
process.exit(saida);

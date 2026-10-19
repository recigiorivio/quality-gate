// Liga e desliga o que este clone instala FORA de si mesmo: os gatilhos no `.claude/settings.json`,
// o LaunchAgent que mantém a tela no ar, o app de Mac, e as rotinas plantadas no workspace.
//
// Existe porque a instalação até aqui entregava os arquivos e deixava o acionamento por conta de
// alguém lembrar de editar um JSON à mão — e rotina que depende de lembrar não é acionada. O par
// `--remove` não é cortesia: a partir do momento em que a instalação escreve em três lugares,
// instalação sem desinstalação deixa lixo que ninguém sabe de onde veio.
//
// São perguntas SEPARADAS, e não um pacote: gatilho é o que aciona a rotina, agente é o que mantém
// a tela viva, app é a janela. Quem quer um não necessariamente quer o outro.
import { createInterface } from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { devNull } from 'node:os';
import { WORKSPACE } from '../lib/diff.mjs';
import {
    caminhoSettings, lerSettings, gravarSettings, comGatilhos, semGatilhos,
    jaRegistrados, outrosClones, plantados, removerPlantados, faltando, plantar, EVENTOS
} from '../lib/gatilhos.mjs';
import * as servico from '../lib/servico.mjs';
import * as app from '../lib/app.mjs';
import * as appWindows from '../lib/app-windows.mjs';

const PROJETO = dirname(dirname(fileURLToPath(import.meta.url)));
const SETTINGS = caminhoSettings(WORKSPACE);
const COMANDO_SUBIR = '/quality-subir-tela';
const args = process.argv.slice(2);
const tem = f => args.includes(f);
const portaPedida = (args.find(a => a.startsWith('--porta=')) || '').split('=')[1];
const porta = Number(portaPedida || servico.PORTA_PADRAO);

// Mesma interface nos dois: Swift + WebKit no Mac, lançador PowerShell + Edge em modo app no Windows.
const appDaPlataforma = appWindows.suportado() ? appWindows : app;

function portaDoApp() {
    return portaPedida ? porta : app.portaDaTela(PROJETO);
}

function curto(caminho) {
    const r = relative(WORKSPACE, caminho);
    return r.startsWith('..') ? caminho : r;
}

// `curl` e não `nc`: o Windows não tem `nc`, e o `curl` vem nele desde o Windows 10.
function telaNoAr() {
    try {
        execFileSync('curl', ['-s', '-o', devNull, '-m', '1.5', `http://127.0.0.1:${porta}/favicon.svg`],
            { timeout: 2500, stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function status() {
    const { settings } = lerSettings(SETTINGS);
    const meus = jaRegistrados(settings, PROJETO);
    const s = servico.suportado() ? servico.estado(PROJETO) : null;
    const md = plantados(WORKSPACE);
    console.log(`workspace   ${WORKSPACE}`);
    console.log(`clone       ${PROJETO}`);
    console.log(`settings    ${existsSync(SETTINGS) ? curto(SETTINGS) : `${curto(SETTINGS)} (não existe ainda)`}`);
    console.log(`\ngatilhos    ${meus.length ? meus.join(', ') : 'nenhum deste clone'}`);
    for (const o of outrosClones(settings, PROJETO)) {
        console.log(`  ⚠ também registrado: ${o}  → a rotina vai chegar duas vezes`);
    }
    if (!s) {
        console.log(`serviço     indisponível (LaunchAgent é só macOS; aqui use um unit de usuário do systemd)`);
    } else {
        console.log(`serviço     ${s.instalado
            ? `${s.carregado ? 'carregado' : 'instalado, NÃO carregado'} · ${curto(s.plist)}`
            : 'não instalado'}${s.log ? ` · log ${(s.log / 1024).toFixed(0)} KB` : ''}`);
        for (const outro of servico.outrosAgentes(PROJETO)) {
            const p = servico.portaDoPlist(outro);
            const onde = servico.projetoDoPlist(outro) || outro;
            console.log(`  · agente de outro clone: ${onde} na porta ${p ?? '?'}`
                + (p === porta || p === null ? `  ⚠ disputa da porta ${porta}` : ''));
        }
    }
    console.log(`tela        ${telaNoAr() ? `no ar na ${porta}` : `fora do ar (${COMANDO_SUBIR} sobe)`}`);
    const a = appDaPlataforma.suportado() ? appDaPlataforma.estado(PROJETO) : null;
    console.log(`app         ${descreverApp(a)}`);
    console.log(`rotinas     ${md.length ? md.map(c => curto(c.absoluto)).join(', ') : 'nenhuma plantada'}`);
    return { settings, meus, servicoEstado: s, appEstado: a, md };
}

// Cada aviso aqui é um jeito de o app abrir e não servir a tela, sem nada no app que explique antes.
function descreverApp(a) {
    if (!a) {
        return 'indisponível neste sistema (há app para macOS e Windows)';
    }
    if (!a.instalado) {
        return 'não instalado';
    }
    if (!a.nosso) {
        return `⚠ ${a.caminho} existe e não é o quality-gate`;
    }
    if (!a.meu) {
        return `de outro clone: ${a.clone}`;
    }
    const avisos = [
        a.nodeExiste === false && `⚠ o node gravado sumiu (${a.node}) — rode --app`,
        a.porta !== a.portaDaTela && `⚠ o app abre a porta ${a.porta}, e a tela sobe na ${a.portaDaTela} — rode --app`,
        a.desatualizado && `⚠ o fonte do app mudou desde a construção (de ${a.commit}) — rode --app`
    ].filter(Boolean);
    return [`${curto(a.caminho)} · porta ${a.porta}`, ...avisos].join('\n              ');
}

function construirApp() {
    const portaApp = portaDoApp();
    console.log(`  destino ${appDaPlataforma.caminhoInstalado()}`);
    console.log(`  node    ${process.execPath}`);
    console.log(`  porta   ${portaApp}`);
    console.log('  compilando…');
    const r = appDaPlataforma.construir(PROJETO, { porta: portaApp });
    if (!r.ok) {
        console.log(`  ⚠ ${r.erro}`);
        return false;
    }
    console.log(`✓ ${r.caminho} em ${r.segundos}s${r.icone ? '' : ' (sem ícone: o sips não converteu o svg)'}`
        + `${r.assinado ? '' : ' (sem assinatura ad-hoc)'}`);
    console.log(`  ${appDaPlataforma.COMO_ABRIR}`);
    return true;
}

async function perguntar(pergunta, padraoSim = true) {
    if (tem('--sim')) {
        return true;
    }
    if (!process.stdin.isTTY) {
        console.log(`  (sem terminal interativo — respondendo "não". Use --sim para aceitar tudo.)`);
        return false;
    }
    const io = createInterface({ input: process.stdin, output: process.stdout });
    const r = await io.question(`${pergunta} ${padraoSim ? '[S/n]' : '[s/N]'} `);
    io.close();
    const t = r.trim();
    return t === '' ? padraoSim : /^s/i.test(t);
}

async function adicionar({ settings, meus, servicoEstado, appEstado }) {
    const eventosFaltando = EVENTOS.filter(e => !meus.includes(e.evento));
    console.log('\n── 1. Gatilhos de qualidade ───────────────────────────────────');
    if (!eventosFaltando.length) {
        console.log('já registrados, nada a fazer');
    } else {
        console.log('Fazem a rotina de fim chegar sozinha quando você fala de commit, PR ou merge,');
        console.log('e derrubam o cache da tela depois de um commit. Não bloqueiam nada.');
        for (const { evento, argumento } of eventosFaltando) {
            console.log(`  ${evento.padEnd(17)} → node ${join(PROJETO, 'hook/gate.mjs')} ${argumento}`);
        }
        if (await perguntar('\nInstalar os gatilhos de qualidade? (recomendado)')) {
            const backup = gravarSettings(SETTINGS, comGatilhos(settings, PROJETO));
            console.log(`✓ gravado em ${curto(SETTINGS)}${backup ? ` · backup em ${curto(backup)}` : ''}`);
            console.log('  ⚠ só vale na PRÓXIMA sessão do Claude Code — a atual já leu o settings');
        } else {
            console.log('· pulado');
        }
    }

    console.log('\n── 2. Serviço que mantém a tela no ar ─────────────────────────');
    if (!servico.suportado()) {
        console.log('indisponível fora do macOS — pulando');
    } else if (servicoEstado.instalado) {
        console.log(`já instalado (${curto(servicoEstado.plist)}), nada a fazer`);
    } else {
        console.log(`Sem ele a tela não sobe sozinha: \`npm start\` num terminal morre com o terminal,`);
        console.log(`e reboot derruba. Com ele, volta sozinha — e ${COMANDO_SUBIR} continua servindo`);
        console.log('para os casos em que você quer subir na mão.');
        console.log(`  plist   ${servico.caminhoPlist(PROJETO)}`);
        console.log(`  node    ${process.execPath}`);
        console.log(`  porta   ${porta}`);
        for (const o of servico.outrosAgentes(PROJETO)) {
            const p = servico.portaDoPlist(o);
            console.log(p === porta || p === null
                ? `  ⚠ já há agente de ${servico.projetoDoPlist(o) || o} na MESMA porta ${porta} — os dois brigariam`
                : `  · já há agente de ${servico.projetoDoPlist(o) || o}, na porta ${p} — sem conflito com a ${porta}`);
        }
        if (telaNoAr()) {
            console.log(`  ⚠ a porta ${porta} já está ocupada agora; se não for este clone, o agente entra em laço de erro`);
        }
        if (await perguntar('\nInstalar o LaunchAgent?')) {
            const r = servico.instalar(PROJETO, { porta });
            console.log(`✓ plist em ${r.plist}`);
            if (!r.ok) {
                console.log(`  ⚠ launchctl recusou: ${r.erro}`);
            }
            console.log(`  tela ${await esperarTela() ? `no ar na ${porta}` : 'ainda não respondeu — veja servico.log'}`);
        } else {
            console.log('· pulado');
        }
    }

    console.log('\n── 3. App (macOS ou Windows) ──────────────────────────────────');
    if (!appDaPlataforma.suportado()) {
        console.log('indisponível neste sistema — há app para macOS e Windows; pulando');
    } else if (appEstado.instalado && appEstado.meu && !appEstado.desatualizado && appEstado.nodeExiste
        && appEstado.porta === portaDoApp()) {
        console.log(`já instalado (${curto(appEstado.caminho)}), nada a fazer — --app reconstrói`);
    } else if (appEstado.instalado && !appEstado.nosso) {
        console.log(`${appEstado.caminho} existe e não é o quality-gate — não mexo`);
    } else if (appDaPlataforma.requisitoFaltando()) {
        console.log(`${appDaPlataforma.requisitoFaltando()} — resolva e rode --app`);
    } else {
        console.log('A tela numa janela própria, com ícone (Dock ou menu Iniciar), em vez de uma aba do navegador.');
        console.log('Se a tela estiver fora do ar o app a sobe: pelo LaunchAgent, se houver; senão');
        console.log('ele mesmo, e aí o servidor para quando o app fecha.');
        if (appEstado.instalado && !appEstado.meu) {
            console.log(`  ⚠ o app instalado é do clone ${appEstado.clone}, e passa a ser deste`);
        }
        if (await perguntar(`\n${appEstado.instalado ? 'Reconstruir' : 'Instalar'} o app?`)) {
            construirApp();
        } else {
            console.log('· pulado');
        }
    }

    console.log('\n── 4. Rotinas que faltam no workspace ─────────────────────────');
    const faltam = faltando(WORKSPACE);
    if (!faltam.length) {
        console.log('nenhuma — as quatro estão plantadas');
    } else {
        console.log('Vieram em versão mais nova do que a sua instalação, ou nunca foram plantadas.');
        console.log('Padrão genérico; para apontar um .md seu, use a aba Configurações da tela.');
        for (const f of faltam) {
            console.log(`  ${f.caminho}  — ${f.resumo}`);
        }
        if (await perguntar('\nPlantar as que faltam?')) {
            for (const rel of plantar(WORKSPACE, faltam.map(f => f.chave))) {
                console.log(`✓ ${rel}`);
            }
            console.log('  ⚠ comando novo aparece na PRÓXIMA sessão do Claude Code');
        } else {
            console.log('· pulado');
        }
    }

    console.log(`\n── E o comando ────────────────────────────────────────────────`);
    console.log(`${COMANDO_SUBIR} sobe a tela quando ela estiver fora do ar (e devolve o link quando`);
    console.log('já estiver). É um dos markdown plantados, e sai no --remove com o resto.');
    return 0;
}

// Esperar de verdade em vez de declarar sucesso: "o launchctl não reclamou" não é a tela no ar, e
// PATH errado no plist sobe o processo e quebra só na primeira chamada ao `gh`.
async function esperarTela(tentativas = 15) {
    for (let i = 0; i < tentativas; i++) {
        if (telaNoAr()) {
            return true;
        }
        await new Promise(r => setTimeout(r, 400));
    }
    return false;
}

async function remover({ settings, meus, servicoEstado, appEstado, md }) {
    const temServico = servicoEstado?.instalado;
    const temApp = appEstado?.instalado && appEstado.nosso && appEstado.meu;
    if (!meus.length && !temServico && !temApp && !md.length) {
        console.log('\nnada deste clone para remover');
        return 0;
    }
    console.log('\nvai remover:');
    for (const evento of meus) {
        console.log(`  gatilho  ${evento}`);
    }
    if (temServico) {
        console.log(`  serviço  ${servicoEstado.rotulo} (a tela para de subir sozinha)`);
    }
    if (temApp) {
        console.log(`  app      ${curto(appEstado.caminho)}`);
    }
    for (const c of md) {
        console.log(`  rotina   ${curto(c.absoluto)}  (guarda .bak antes de apagar)`);
    }
    if (!await perguntar('\nConfirmar?', false)) {
        console.log('nada removido');
        return 0;
    }
    if (meus.length) {
        const backup = gravarSettings(SETTINGS, semGatilhos(settings, PROJETO));
        console.log(`✓ settings limpo${backup ? ` · backup em ${curto(backup)}` : ''}`);
    }
    if (temServico) {
        const r = servico.remover(PROJETO);
        console.log(`✓ serviço removido${r.descarregou ? '' : ' (launchctl já não o tinha carregado)'}`);
    }
    if (temApp) {
        const r = appDaPlataforma.remover(PROJETO);
        console.log(r.removido ? '✓ app removido' : `· app não removido: ${r.motivo}`);
    }
    for (const rel of removerPlantados(WORKSPACE)) {
        console.log(`✓ ${rel} removido (cópia em ${rel}.bak)`);
    }
    console.log('\nfalta só o que mora fora do workspace, e é seu para decidir:');
    console.log('  rm -rf ~/.claude/skills/instalar-quality-gate');
    console.log(`  rm -rf ${PROJETO}`);
    return 0;
}

const atual = status();
let saida = 0;
if (tem('--add')) {
    saida = await adicionar(atual);
} else if (tem('--remove')) {
    saida = await remover(atual);
} else if (tem('--app')) {
    console.log('\n── App para Mac ───────────────────────────────────────────────');
    saida = appDaPlataforma.suportado() ? (construirApp() ? 0 : 1) : 1;
} else {
    console.log('\n--add para instalar (pergunta gatilhos, serviço e app separadamente)');
    console.log('--app (re)constrói só o app de Mac — depois de trocar de node pelo nvm, ou de porta');
    console.log('--remove para desfazer tudo deste clone · --sim aceita sem perguntar · --porta=4200');
}
process.exit(saida);

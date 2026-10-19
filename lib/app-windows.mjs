// O app de Windows: o par do `mac/QualityGate.swift`, com o Edge em modo app no lugar do WKWebView.
//
// Edge e não um executável compilado: ele vem em todo Windows 10/11, abre a tela numa janela própria
// sem barra de endereço, e `confirm()`, seletor de arquivo e área de transferência funcionam de
// fábrica — os quatro buracos que o app de Mac precisou tapar à mão não existem aqui. Compilar teria
// custo sem ganho: WebView2 pede o SDK (dependência), e o controle WebBrowser do .NET Framework é o
// motor do Internet Explorer.
//
// Construído na máquina de quem usa, como o de Mac: `--app` copia o lançador para
// %LOCALAPPDATA%\QualityGate, grava o config.json (clone, node absoluto, porta), gera o .ico a partir
// do `mac/icone.svg` com o próprio Edge sem cabeça, e cria o atalho no menu Iniciar.
//
// ⚠ Escrito num Mac. O .ico e a renderização do ícone foram conferidos aqui com o Chrome, que é o
// mesmo motor do Edge; o PowerShell (lançador e atalho) só roda de verdade no Windows.
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { portaDaTela } from './app.mjs';
import { PORTA_PADRAO } from './servico.mjs';

const NOME = 'Quality Gate';
const LANCADOR = 'windows/QualityGate.ps1';
const ICONE = 'mac/icone.svg';
const MARCA = 'quality-gate';

export function suportado() {
    return process.platform === 'win32';
}

export function pastaApp(env = process.env) {
    return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'QualityGate');
}

export function caminhoInstalado(env = process.env) {
    return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${NOME}.lnk`);
}

export function navegador(env = process.env, existe = existsSync) {
    return [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA]
        .filter(Boolean)
        .map(raiz => join(raiz, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
        .find(c => existe(c)) || null;
}

export function requisitoFaltando() {
    return navegador() ? null : 'sem o Microsoft Edge (msedge.exe): o app abre a tela numa janela dele';
}

export const COMO_ABRIR = `procure "${NOME}" no menu Iniciar (dá para fixar na barra de tarefas)`;

// ICO com PNG dentro, o formato desde o Windows Vista: 6 bytes de cabeçalho, 16 por tamanho, os PNGs.
// Lado 256 se escreve 0 — o campo tem um byte.
export function ico(pngs) {
    const cabeca = Buffer.alloc(6);
    cabeca.writeUInt16LE(1, 2);
    cabeca.writeUInt16LE(pngs.length, 4);
    let deslocamento = 6 + 16 * pngs.length;
    const entradas = pngs.map(({ lado, png }) => {
        const e = Buffer.alloc(16);
        e.writeUInt8(lado >= 256 ? 0 : lado, 0);
        e.writeUInt8(lado >= 256 ? 0 : lado, 1);
        e.writeUInt16LE(1, 4);
        e.writeUInt16LE(32, 6);
        e.writeUInt32LE(png.length, 8);
        e.writeUInt32LE(deslocamento, 12);
        deslocamento += png.length;
        return e;
    });
    return Buffer.concat([cabeca, ...entradas, ...pngs.map(p => p.png)]);
}

// SVG aberto direto o Chromium não encaixa na janela (saía deslocado e cortado): vai numa página de
// tamanho fixo. A ampliação tira a margem da grade do macOS, que no menu Iniciar deixava o ícone miúdo.
export function paginaDoIcone(urlDoSvg, lado) {
    const ampliado = Math.round(lado * 1024 / 864);
    const recuo = Math.round(lado * 80 / 864);
    return `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">`
        + `<img src="${urlDoSvg}" style="display:block;width:${ampliado}px;height:${ampliado}px;margin:-${recuo}px 0 0 -${recuo}px">`
        + '</body></html>';
}

export function renderizar(projeto, exe, lados = [256, 48, 32, 16]) {
    const tmp = mkdtempSync(join(tmpdir(), 'quality-gate-icone-'));
    try {
        const svg = `file:///${join(projeto, ICONE).replace(/\\/g, '/').replace(/^\//, '')}`;
        return lados.map(lado => {
            const html = join(tmp, `icone-${lado}.html`);
            const png = join(tmp, `icone-${lado}.png`);
            writeFileSync(html, paginaDoIcone(svg, lado));
            execFileSync(exe, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
                '--default-background-color=00000000', '--allow-file-access-from-files', `--user-data-dir=${join(tmp, 'perfil')}`,
                `--window-size=${lado},${lado}`, `--screenshot=${png}`, `file:///${html.replace(/\\/g, '/').replace(/^\//, '')}`],
            { stdio: 'ignore', timeout: 60000 });
            return { lado, png: readFileSync(png) };
        });
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

// O que o lançador lê. `app` é a marca: sem ela, uma pasta QualityGate de outra origem seria tratada como nossa.
export function config(projeto, { porta = PORTA_PADRAO, node = process.execPath, fonte = '', commit = '' } = {}) {
    return { app: MARCA, clone: projeto, node, porta: Number(porta), fonte, commit };
}

export function hashFonte(projeto) {
    try {
        const h = createHash('sha1');
        for (const arquivo of [LANCADOR, ICONE]) {
            h.update(readFileSync(join(projeto, arquivo)));
        }
        return h.update(config.toString()).digest('hex').slice(0, 12);
    } catch {
        return null;
    }
}

function aspas(s) {
    return `'${String(s).replace(/'/g, "''")}'`;
}

export function scriptAtalho({ atalho, pasta, icone }) {
    const powershell = '$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const argumentos = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${win32.join(pasta, 'QualityGate.ps1')}"`;
    return [
        `$a = (New-Object -ComObject WScript.Shell).CreateShortcut(${aspas(atalho)})`,
        `$a.TargetPath = "${powershell}"`,
        `$a.Arguments = ${aspas(argumentos)}`,
        `$a.WorkingDirectory = ${aspas(pasta)}`,
        icone ? `$a.IconLocation = ${aspas(`${icone},0`)}` : null,
        `$a.Description = ${aspas(NOME)}`,
        '$a.Save()'
    ].filter(Boolean).join('; ');
}

function commitAtual(projeto) {
    try {
        return execFileSync('git', ['-C', projeto, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return '';
    }
}

export function estado(projeto, { pasta = pastaApp(), atalho = caminhoInstalado() } = {}) {
    let c = null;
    try {
        c = JSON.parse(readFileSync(join(pasta, 'config.json'), 'utf8'));
    } catch {
        c = null;
    }
    const meu = c?.clone === projeto;
    return {
        caminho: atalho,
        instalado: Boolean(c),
        nosso: c?.app === MARCA,
        clone: c?.clone ?? null,
        meu,
        porta: c ? Number(c.porta) || null : null,
        portaDaTela: meu ? portaDaTela(projeto) : null,
        node: c?.node ?? null,
        nodeExiste: c?.node ? existsSync(c.node) : null,
        commit: c?.commit || null,
        desatualizado: meu && c.fonte ? c.fonte !== hashFonte(projeto) : null,
        atalhoExiste: existsSync(atalho)
    };
}

export function construir(projeto, { porta = PORTA_PADRAO, node = process.execPath, pasta = pastaApp(), atalho = caminhoInstalado(), exe = navegador(), criarAtalho = true } = {}) {
    const atual = estado(projeto, { pasta, atalho });
    if (atual.instalado && !atual.nosso) {
        return { ok: false, erro: `${pasta} existe e não é do quality-gate — não sobrescrevo` };
    }
    if (!exe) {
        return { ok: false, erro: requisitoFaltando() };
    }
    const inicio = Date.now();
    try {
        mkdirSync(pasta, { recursive: true });
        writeFileSync(join(pasta, 'QualityGate.ps1'), `\uFEFF${readFileSync(join(projeto, LANCADOR), 'utf8')}`);
        writeFileSync(join(pasta, 'config.json'), JSON.stringify(config(projeto, { porta, node, fonte: hashFonte(projeto), commit: commitAtual(projeto) }), null, 2));
        let icone = null;
        try {
            writeFileSync(join(pasta, 'QualityGate.ico'), ico(renderizar(projeto, exe)));
            icone = join(pasta, 'QualityGate.ico');
        } catch {
            icone = null;
        }
        if (criarAtalho) {
            execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', scriptAtalho({ atalho, pasta, icone })],
                { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
        }
        return { ok: true, caminho: atalho, icone: Boolean(icone), assinado: true, segundos: Math.round((Date.now() - inicio) / 1000) };
    } catch (e) {
        return { ok: false, erro: `${e.stderr || e.message}`.trim().slice(0, 800) };
    }
}

// Leva o atalho e a pasta inteira: o perfil do Edge (o localStorage da janela) e os logs moram nela.
export function remover(projeto, { pasta = pastaApp(), atalho = caminhoInstalado() } = {}) {
    const e = estado(projeto, { pasta, atalho });
    if (!e.instalado) {
        return { removido: false, motivo: 'não instalado' };
    }
    if (!e.nosso || !e.meu) {
        return { removido: false, motivo: e.nosso ? `é de outro clone: ${e.clone}` : 'não é do quality-gate' };
    }
    rmSync(atalho, { force: true });
    rmSync(pasta, { recursive: true, force: true });
    return { removido: true };
}

export { NOME, LANCADOR, ICONE };

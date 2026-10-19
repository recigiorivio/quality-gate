// O app de Mac: constrói `~/Applications/Quality Gate.app` a partir de `mac/QualityGate.swift`.
//
// O app é uma janela em volta da tela, não uma segunda tela — quem serve continua sendo o
// `server.mjs`. Por isso a construção não empacota node nem o projeto: ela assa no Info.plist o
// caminho deste clone, o node por caminho absoluto, o PATH e a porta, pelos mesmos motivos do plist
// do LaunchAgent (ver `servico.mjs`). Trocar de node pelo nvm ou de porta exige construir de novo.
//
// Swift e não Electron: o projeto não tem dependência de runtime, e o `swiftc` vem com as Command
// Line Tools que o `git` do macOS já exige. O ícone sai do `mac/icone.svg` pelo `sips` do sistema,
// na hora — binário derivado no git é binário que ninguém sabe regenerar.
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, mkdtempSync, utimesSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rotulo, pathEstavel, caminhoPlist, portaDoPlist, PORTA_PADRAO } from './servico.mjs';

const NOME = 'Quality Gate';
const ID = 'io.github.recigiorivio.quality-gate';
const EXECUTAVEL = 'QualityGate';
const FONTE = 'mac/QualityGate.swift';
const ICONE = 'mac/icone.svg';
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

export function suportado() {
    return process.platform === 'darwin';
}

export function caminhoApp() {
    return join(homedir(), 'Applications', `${NOME}.app`);
}

// `xcode-select -p` antes do `xcrun`: sem as Command Line Tools o `xcrun` abre o diálogo de
// instalação, e quem só perguntou o estado recebe uma janela.
export function swiftc() {
    try {
        execFileSync('xcode-select', ['-p'], { stdio: 'ignore', timeout: 5000 });
        return execFileSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim() || null;
    } catch {
        return null;
    }
}

function escapar(texto) {
    return String(texto).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function infoPlist(projeto, { porta = PORTA_PADRAO, node = process.execPath, path = process.env.PATH, versao = '0.0.0', commit = '', fonte = '' } = {}) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${NOME}</string>
  <key>CFBundleDisplayName</key><string>${NOME}</string>
  <key>CFBundleIdentifier</key><string>${ID}</string>
  <key>CFBundleExecutable</key><string>${EXECUTAVEL}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleShortVersionString</key><string>${escapar(versao)}</string>
  <key>CFBundleVersion</key><string>${escapar(commit || versao)}</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
  <key>QGClone</key><string>${escapar(projeto)}</string>
  <key>QGNode</key><string>${escapar(node)}</string>
  <key>QGPath</key><string>${escapar(pathEstavel(path))}</string>
  <key>QGPorta</key><string>${escapar(porta)}</string>
  <key>QGRotulo</key><string>${escapar(rotulo(projeto))}</string>
  <key>QGCommit</key><string>${escapar(commit)}</string>
  <key>QGFonte</key><string>${escapar(fonte)}</string>
</dict>
</plist>
`;
}

// Pelo `plutil`, não por regex: qualquer ferramenta que regrave o Info.plist (o próprio `plutil
// -replace`, o Xcode) muda a formatação, e a regex deixava de reconhecer o app como nosso.
export function lerInfo(caminhoPlist) {
    try {
        return JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', caminhoPlist], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch {
        return {};
    }
}

// Hash do que vai para dentro do bundle, e não o commit: construído de árvore com mudança não
// commitada, o `git diff` contra o commit acusava "desatualizado" num app recém-construído.
export function hashFonte(projeto) {
    try {
        const h = createHash('sha1');
        for (const arquivo of [FONTE, ICONE]) {
            h.update(readFileSync(join(projeto, arquivo)));
        }
        return h.update(infoPlist.toString()).digest('hex').slice(0, 12);
    } catch {
        return null;
    }
}

// A porta em que a tela de fato sobe: a do LaunchAgent deste clone ganha do `PORT`, como no servidor.
export function portaDaTela(projeto, env = process.env) {
    const doAgente = existsSync(caminhoPlist(projeto)) ? portaDoPlist(caminhoPlist(projeto)) : null;
    return doAgente || Number(env.PORT) || PORTA_PADRAO;
}

export function estado(projeto, destino = caminhoApp()) {
    const plist = join(destino, 'Contents/Info.plist');
    const instalado = existsSync(plist);
    const info = instalado ? lerInfo(plist) : {};
    const clone = info.QGClone ?? null;
    const node = info.QGNode ?? null;
    const commit = info.QGCommit || null;
    const porta = Number(info.QGPorta) || null;
    return {
        caminho: destino,
        instalado,
        nosso: info.CFBundleIdentifier === ID,
        clone,
        meu: clone === projeto,
        porta,
        portaDaTela: clone === projeto ? portaDaTela(projeto) : null,
        node,
        nodeExiste: node ? existsSync(node) : null,
        commit,
        desatualizado: clone === projeto && info.QGFonte ? info.QGFonte !== hashFonte(projeto) : null
    };
}

function gerarIcone(projeto, tmp, destino) {
    try {
        const base = join(tmp, 'icone-1024.png');
        const conjunto = join(tmp, 'AppIcon.iconset');
        mkdirSync(conjunto);
        execFileSync('sips', ['-s', 'format', 'png', '-Z', '1024', join(projeto, ICONE), '--out', base], { stdio: 'ignore', timeout: 30000 });
        for (const lado of [16, 32, 128, 256, 512]) {
            execFileSync('sips', ['-z', String(lado), String(lado), base, '--out', join(conjunto, `icon_${lado}x${lado}.png`)], { stdio: 'ignore' });
            execFileSync('sips', ['-z', String(lado * 2), String(lado * 2), base, '--out', join(conjunto, `icon_${lado}x${lado}@2x.png`)], { stdio: 'ignore' });
        }
        execFileSync('iconutil', ['-c', 'icns', conjunto, '-o', destino], { stdio: 'ignore', timeout: 30000 });
        return true;
    } catch {
        return false;
    }
}

// O LaunchServices guarda o Info.plist por caminho e só relê quando a data do bundle muda: sem isto,
// reconstruir com outra porta ou outro node abria o app com a configuração antiga.
function registrar(destino) {
    try {
        const agora = new Date();
        utimesSync(destino, agora, agora);
        execFileSync(LSREGISTER, ['-f', destino], { stdio: 'ignore', timeout: 30000 });
    } catch {
        // sem o registro o app abre igual; só o cache pode demorar a perceber a troca
    }
}

function commitAtual(projeto) {
    try {
        return execFileSync('git', ['-C', projeto, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return '';
    }
}

export function construir(projeto, { porta = PORTA_PADRAO, node = process.execPath, path = process.env.PATH, destino = caminhoApp() } = {}) {
    const atual = estado(projeto, destino);
    if (atual.instalado && !atual.nosso) {
        return { ok: false, erro: `${destino} existe e não é o quality-gate — não sobrescrevo` };
    }
    if (!swiftc()) {
        return { ok: false, erro: 'sem swiftc — instale as Command Line Tools: xcode-select --install' };
    }
    const inicio = Date.now();
    const tmp = mkdtempSync(join(tmpdir(), 'quality-gate-app-'));
    try {
        const app = join(tmp, `${NOME}.app`);
        mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
        mkdirSync(join(app, 'Contents/Resources'));
        // Pelo `xcrun`, não pelo caminho que ele achou: chamado direto, o swiftc não acha o SDK e falha com
        // "unable to load standard library".
        execFileSync('xcrun', ['swiftc', '-O', '-parse-as-library', '-o', join(app, 'Contents/MacOS', EXECUTAVEL), join(projeto, FONTE)],
            { stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
        const icone = gerarIcone(projeto, tmp, join(app, 'Contents/Resources/AppIcon.icns'));
        const versao = JSON.parse(readFileSync(join(projeto, 'package.json'), 'utf8')).version;
        writeFileSync(join(app, 'Contents/Info.plist'), infoPlist(projeto, { porta, node, path, versao, commit: commitAtual(projeto), fonte: hashFonte(projeto) }));
        // Ad-hoc: o linker assina só o executável, e o Info.plist escrito depois quebraria o selo do bundle.
        let assinado = true;
        try {
            execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'ignore', timeout: 60000 });
        } catch {
            assinado = false;
        }
        rmSync(destino, { recursive: true, force: true });
        mkdirSync(dirname(destino), { recursive: true });
        execFileSync('ditto', [app, destino], { stdio: 'ignore', timeout: 60000 });
        registrar(destino);
        return { ok: true, caminho: destino, icone, assinado, segundos: Math.round((Date.now() - inicio) / 1000) };
    } catch (e) {
        return { ok: false, erro: `${e.stderr || e.message}`.trim().slice(0, 800) };
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

// Só remove o app DESTE clone; os dados do WKWebView vão junto porque são chaveados pelo bundle id.
export function remover(projeto, destino = caminhoApp()) {
    const e = estado(projeto, destino);
    if (!e.instalado) {
        return { removido: false, motivo: 'não instalado' };
    }
    if (!e.nosso || !e.meu) {
        return { removido: false, motivo: e.nosso ? `é de outro clone: ${e.clone}` : 'não é o quality-gate' };
    }
    rmSync(destino, { recursive: true, force: true });
    if (destino === caminhoApp()) {
        const lib = join(homedir(), 'Library');
        for (const resto of [`WebKit/${ID}`, `Caches/${ID}`, `HTTPStorages/${ID}`, `Saved Application State/${ID}.savedState`, `Preferences/${ID}.plist`]) {
            rmSync(join(lib, resto), { recursive: true, force: true });
        }
    }
    return { removido: true };
}

export { NOME, ID, EXECUTAVEL, FONTE };

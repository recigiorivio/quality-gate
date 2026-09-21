// O LaunchAgent que mantém a tela no ar entre reboots e fechamentos de terminal.
//
// Existe porque `npm start` num terminal morre com o terminal (SIGHUP), e o hook degrada em
// silêncio: sem tela ele entrega um HTML temporário em vez do link. Funciona, mas a pessoa acha que
// instalou uma tela e recebe um arquivo.
//
// Três coisas aqui não são detalhe, e cada uma foi medida nesta máquina:
//
// 1. O `node` vai por caminho ABSOLUTO. O launchd não resolve nome, e num node de `nvm` o caminho
//    carrega a versão — trocar de node pelo nvm exige rodar o `--add` de novo.
// 2. O `PATH` do processo que instalou é assado no plist. O PATH padrão do launchd é
//    `/usr/bin:/bin:/usr/sbin:/sbin`, e o `gh` mora em `/opt/homebrew/bin`: sem assar, a tela sobe
//    e perde PR, base observada e checks — sem erro nenhum, que é o pior jeito de quebrar.
// 3. O rótulo leva um hash do caminho do clone. Dois clones podem ter agente próprio; o que eles
//    não podem é disputar a porta, e disso cuida quem chama.
import { readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const PORTA_PADRAO = 4100;

export function suportado() {
    return process.platform === 'darwin';
}

export function rotulo(projeto) {
    return `quality-gate.${createHash('sha1').update(projeto).digest('hex').slice(0, 8)}`;
}

export function caminhoPlist(projeto) {
    return join(homedir(), 'Library', 'LaunchAgents', `${rotulo(projeto)}.plist`);
}

export function caminhoLog(projeto) {
    return join(projeto, 'servico.log');
}

function escapar(texto) {
    return String(texto).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// O PATH de quem instala carrega lixo de sessão: shim em diretório temporário, cache de plugin com
// versão pinada. Entrada morta em PATH não quebra nada, mas assar `/var/folders/.../T/...` num
// serviço que atravessa reboot é errado de cara — e no dia em que esse caminho existir de novo,
// com outro conteúdo, o serviço passa a achar binário que ninguém pediu.
export function pathEstavel(path = process.env.PATH) {
    const temp = tmpdir();
    const limpo = String(path || '').split(':')
        .filter(d => d && !d.startsWith(temp) && !d.startsWith('/private' + temp) && !d.startsWith('/tmp/'));
    return limpo.length ? limpo.join(':') : '/usr/bin:/bin:/usr/sbin:/sbin';
}

export function plist(projeto, { porta = PORTA_PADRAO, node = process.execPath, path = process.env.PATH } = {}) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapar(rotulo(projeto))}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapar(node)}</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>${escapar(join(projeto, 'server.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapar(projeto)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escapar(pathEstavel(path))}</string>
    <key>PORT</key><string>${escapar(porta)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${escapar(caminhoLog(projeto))}</string>
</dict>
</plist>
`;
}

// `bootstrap`/`bootout` são a forma atual; `load -w`/`unload -w` ficam como plano B porque o
// `bootstrap` não existe em macOS antigo. Falhar aqui não pode derrubar quem chamou: a instalação
// segue útil com a tela subida à mão.
function launchctl(args) {
    try {
        execFileSync('launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
        return { ok: true };
    } catch (e) {
        return { ok: false, erro: `${e.stderr || e.stdout || e.message}`.trim().slice(0, 200) };
    }
}

export function carregado(projeto) {
    const r = launchctl(['print', `gui/${process.getuid()}/${rotulo(projeto)}`]);
    return r.ok;
}

export function instalar(projeto, opcoes = {}) {
    const alvo = caminhoPlist(projeto);
    writeFileSync(alvo, plist(projeto, opcoes));
    // Log zerado a cada instalação: `KeepAlive` com o servidor em laço de erro escreve sem teto, e
    // um arquivo que só cresce esconde quando o problema começou.
    writeFileSync(caminhoLog(projeto), '');
    const uid = process.getuid();
    let r = launchctl(['bootstrap', `gui/${uid}`, alvo]);
    if (!r.ok) {
        r = launchctl(['load', '-w', alvo]);
    }
    return { plist: alvo, ...r };
}

export function remover(projeto) {
    const alvo = caminhoPlist(projeto);
    const uid = process.getuid();
    let r = launchctl(['bootout', `gui/${uid}/${rotulo(projeto)}`]);
    if (!r.ok && existsSync(alvo)) {
        r = launchctl(['unload', '-w', alvo]);
    }
    const tinha = existsSync(alvo);
    if (tinha) {
        rmSync(alvo, { force: true });
    }
    rmSync(caminhoLog(projeto), { force: true });
    return { plist: alvo, tinha, descarregou: r.ok };
}

export function estado(projeto) {
    const alvo = caminhoPlist(projeto);
    const log = caminhoLog(projeto);
    return {
        rotulo: rotulo(projeto),
        plist: alvo,
        instalado: existsSync(alvo),
        carregado: existsSync(alvo) && carregado(projeto),
        log: existsSync(log) ? statSync(log).size : null
    };
}

// Agente de OUTRO clone: não é conflito de arquivo, é disputa de porta — os dois sobem `server.mjs`
// na 4100 e o segundo entra em laço de erro com `KeepAlive`.
export function outrosAgentes(projeto) {
    const meu = `${rotulo(projeto)}.plist`;
    const dir = join(homedir(), 'Library', 'LaunchAgents');
    try {
        return execFileSync('ls', [dir], { encoding: 'utf8' }).split('\n')
            .filter(n => n.startsWith('quality-gate.') && n.endsWith('.plist') && n !== meu)
            .map(n => join(dir, n));
    } catch {
        return [];
    }
}

export function projetoDoPlist(caminho) {
    try {
        const texto = readFileSync(caminho, 'utf8');
        return (texto.match(/<key>WorkingDirectory<\/key><string>([^<]+)<\/string>/) || [])[1] || null;
    } catch {
        return null;
    }
}

export { PORTA_PADRAO };

// O que a ferramenta precisa para funcionar, conferido na hora. Uma fonte só para o terminal
// (`instalacao/verificar.mjs`) e para o (i) da tela: na tela a conferência roda no processo da
// própria tela, com o PATH do serviço — que é o que importa, e não o PATH do terminal de quem olha.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { caminhoSettings, lerSettings, jaRegistrados, outrosClones } from './gatilhos.mjs';
import * as appMac from './app.mjs';
import * as appWindows from './app-windows.mjs';
import * as servico from './servico.mjs';

const execFileAsync = promisify(execFile);

export class Dependencias {
    static OK = 'ok';
    static FALTA = 'falta';
    static AVISO = 'aviso';

    constructor({ raiz = dirname(dirname(fileURLToPath(import.meta.url))), workspace, naTela = false, casa = homedir() } = {}) {
        this.raiz = raiz;
        this.workspace = workspace || process.env.QUALIDADE_WORKSPACE || dirname(raiz);
        this.naTela = naTela;
        this.casa = casa;
    }

    async cmd(exec, args) {
        try {
            const { stdout } = await execFileAsync(exec, args, { encoding: 'utf8', timeout: 8000 });
            return stdout.trim();
        } catch {
            return null;
        }
    }

    // Na tela a porta é dela mesma: conferir se está ocupada respondia "em uso" sempre.
    async listar() {
        const { OK, FALTA, AVISO } = Dependencias;
        const item = (grupo, papel, [estado, nome, nota]) => ({ grupo, papel, estado, nome, nota: nota || '' });
        const itens = await Promise.all([
            this.node().then(r => item('obrigatório', 'roda a tela; o estado mora no node:sqlite embutido', r)),
            this.git().then(r => item('obrigatório', 'tudo parte de git diff: branches, base e o antes/depois', r)),
            Promise.resolve(item('obrigatório', 'o parser que lê o código para as análises', this.acorn())),
            Promise.resolve(item('obrigatório', 'a pasta com os repos que a tela lê', this.pastaDosRepos())),
            this.gh().then(r => item('recomendado', 'PRs, base observada, checks e o alvo do The Judge', r)),
            Promise.resolve(item('recomendado', 'o cartão de lint usa o linter de cada repo', this.linters())),
            this.claude().then(r => item('recomendado', 'o mago e o The Judge rodam claude -p', r)),
            this.juiz().then(r => item('opcional', 'o botão Pergunte ao The Judge', r)),
            Promise.resolve(item('opcional', 'a aba Whiteboard lê o quadro pelo comando whiteboard', this.whiteboard())),
            Promise.resolve(item('opcional', 'o cartão de índices confere o plano no Mongo de stage', this.envStg())),
            Promise.resolve(item('opcional', 'injeta a rotina de fim e manda o link da tela no commit e na PR', this.hook())),
            Promise.resolve(item('opcional', 'mantém a tela no ar entre reboots e fechamentos de terminal', this.servico())),
            Promise.resolve(item('opcional', 'a tela numa janela própria, sem navegador', this.app())),
            ...(this.naTela ? [] : [this.porta().then(r => item('opcional', 'onde a tela sobe', r))])
        ]);
        return { itens, faltando: itens.filter(i => i.estado === FALTA).length, avisos: itens.filter(i => i.estado === AVISO).length, ok: OK };
    }

    // O piso sai do `engines.node`, não de um número escrito aqui: com os dois, esta checagem
    // aprovava 20.11 enquanto o projeto já exigia 22.5.0 — e a quebra só aparecia no banco.
    async node() {
        const { OK, FALTA } = Dependencias;
        const piso = this.pisoDoNode();
        const serve = this.compararVersao(process.versions.node, piso) >= 0;
        const nome = this.naTela ? `node ${process.versions.node} · ${process.execPath}` : `node ${process.versions.node}`;
        return [serve ? OK : FALTA, nome,
            serve ? '' : `precisa de ${piso}+ — o estado usa o \`node:sqlite\` embutido, que não`
                + ' existe antes disso; sem ele a tela sobe e quebra no primeiro acesso ao banco'];
    }

    // Sem `engines` legível o piso ainda é conhecido: devolver 0 aqui faria a checagem aprovar tudo.
    pisoDoNode() {
        try {
            const engines = JSON.parse(readFileSync(join(this.raiz, 'package.json'), 'utf8')).engines || {};
            return (engines.node || '').replace(/[^0-9.]/g, '') || '22.5.0';
        } catch {
            return '22.5.0';
        }
    }

    // Número a número: em ordem de texto '20.11.0' vem depois de '22.5.0', que é o jeito de uma
    // comparação de versão aprovar exatamente a versão que ela existe para barrar.
    compararVersao(a, b) {
        const va = a.split('.').map(Number);
        const vb = b.split('.').map(Number);
        for (let i = 0; i < 3; i++) {
            if ((va[i] || 0) !== (vb[i] || 0)) {
                return (va[i] || 0) - (vb[i] || 0);
            }
        }
        return 0;
    }

    async git() {
        const { OK, FALTA } = Dependencias;
        const v = await this.cmd('git', ['--version']);
        return [v ? OK : FALTA, v || 'git', v ? '' : 'obrigatório: tudo parte de git diff'];
    }

    async gh() {
        const { OK, AVISO } = Dependencias;
        const v = await this.cmd('gh', ['--version']);
        if (!v) {
            return [AVISO, 'gh (GitHub CLI)', 'sem ele: nada de PR, base observada nem checks'];
        }
        const auth = await this.cmd('gh', ['auth', 'status']) !== null;
        return [auth ? OK : AVISO, v.split('\n')[0], auth ? '' : 'instalado mas não autenticado: rode `gh auth login`'];
    }

    pastaDosRepos() {
        const { OK, FALTA, AVISO } = Dependencias;
        if (!existsSync(this.workspace)) {
            return [FALTA, this.workspace, 'pasta não existe — aponte QUALIDADE_WORKSPACE'];
        }
        const repos = readdirSync(this.workspace, { withFileTypes: true })
            .filter(d => d.isDirectory() && existsSync(join(this.workspace, d.name, '.git'))).length;
        return [repos ? OK : AVISO, `${this.workspace} (${repos} repo(s) git)`,
            repos ? '' : 'nenhum repo git aqui: a tela vai abrir vazia'];
    }

    // A ferramenta não traz linter: usa o de cada repo. Sem nenhum, o cartão de lint fica cinza.
    linters() {
        const { OK, FALTA, AVISO } = Dependencias;
        if (!existsSync(this.workspace)) {
            return [FALTA, 'linters', 'workspace inválido'];
        }
        let eslint = 0;
        let ruff = 0;
        for (const d of readdirSync(this.workspace, { withFileTypes: true })) {
            if (!d.isDirectory()) {
                continue;
            }
            const raiz = join(this.workspace, d.name);
            if (existsSync(join(raiz, 'eslint.config.mjs')) || existsSync(join(raiz, 'eslint.config.js'))) {
                eslint++;
            }
            if (existsSync(join(raiz, '.venv/bin/ruff')) || existsSync(join(raiz, 'venv/bin/ruff'))) {
                ruff++;
            }
        }
        const total = eslint + ruff;
        return [total ? OK : AVISO, `${eslint} repo(s) com eslint, ${ruff} com ruff`,
            total ? '' : 'nenhum linter nos repos: o cartão de lint fica indisponível'];
    }

    acorn() {
        const { OK, FALTA } = Dependencias;
        const tem = existsSync(join(this.raiz, 'vendor/acorn.mjs'));
        return [tem ? OK : FALTA, 'vendor/acorn.mjs', tem ? '' : 'sem o parser não há análise de código'];
    }

    async claude() {
        const { OK, AVISO } = Dependencias;
        const v = await this.cmd('claude', ['--version']);
        return [v ? OK : AVISO, v ? `claude ${v.split(' ')[0]}` : 'claude (Claude Code CLI)',
            v ? '' : 'fora do PATH: sem ele o mago e o The Judge não rodam'];
    }

    // A skill e o python3 juntos: sem o python3 a skill roda, mas a varredura de bypass e o portão dela não.
    async juiz() {
        const { OK, AVISO } = Dependencias;
        const skill = [join(this.workspace, '.claude/skills/the-judge'), join(this.casa, '.claude/skills/the-judge')]
            .find(d => existsSync(join(d, 'SKILL.md')));
        if (!skill) {
            return [AVISO, 'skill the-judge', 'não instalada: npx @tech-leads-club/agent-skills install --skill the-judge'];
        }
        const python = process.platform === 'win32' ? 'python' : 'python3';
        const v = await this.cmd(python, ['--version']);
        return [v ? OK : AVISO, `skill the-judge · ${v || python}`,
            v ? '' : `${python} fora do PATH: o juiz roda sem a varredura de bypass e sem o portão da skill`];
    }

    // O app do Whiteboard não sobe sozinho: com ele fechado a aba mostra a última leitura guardada.
    whiteboard() {
        const { OK, AVISO } = Dependencias;
        // O caminho do `comandoWhiteboard()`, repetido: importar o whiteboard.mjs puxa o node:sqlite, e isto roda em node velho.
        const comando = process.env.QUALIDADE_WHITEBOARD || join(this.casa, '.local', 'bin', 'whiteboard');
        const tem = existsSync(comando);
        return [tem ? OK : AVISO, `whiteboard · ${comando}`,
            tem ? 'o app não sobe sozinho; fechado, a aba mostra a última leitura guardada'
                : 'não instalado: instale o app dev.fast Whiteboard e marque o Claude Code na instalação'];
    }

    envStg() {
        const { OK, AVISO } = Dependencias;
        const tem = existsSync(join(this.raiz, '.env'));
        return [tem ? OK : AVISO, '.env (consulta ao Mongo de stage)',
            tem ? '' : 'opcional: sem ele o cartão de índices não confirma o plano de execução'];
    }

    // Confere se o hook aponta para ESTE clone, não se existe algum `gate.mjs` no arquivo: com dois
    // clones lado a lado, o `includes('gate.mjs')` dava ok para o install novo por causa do antigo
    // — check que responde ok sem o gatilho estar ligado é pior que check nenhum.
    hook() {
        const { OK, AVISO } = Dependencias;
        const caminho = caminhoSettings(this.workspace);
        if (!existsSync(caminho)) {
            return [AVISO, 'hook', `sem ${relative(this.workspace, caminho)} (opcional: node instalacao/gatilhos.mjs --add)`];
        }
        let settings;
        try {
            settings = lerSettings(caminho).settings;
        } catch (e) {
            return [AVISO, 'hook', e.message];
        }
        const meus = jaRegistrados(settings, this.raiz);
        const outros = outrosClones(settings, this.raiz);
        if (meus.length === 3) {
            return [OK, 'hook deste clone registrado',
                outros.length ? `também há ${outros.length} de outro clone — a rotina chega duas vezes` : ''];
        }
        const detalhe = outros.length
            ? `há hook de ${outros[0]}, mas não deste clone — ligue com node instalacao/gatilhos.mjs --add`
            : 'opcional: sem o hook a rotina de fim não é injetada sozinha (node instalacao/gatilhos.mjs --add)';
        return [AVISO, meus.length ? `hook parcial (${meus.length}/3)` : 'hook não registrado', detalhe];
    }

    // O plist guarda o node por caminho absoluto: trocar de node pelo nvm deixa o serviço sem ter o que rodar.
    servico() {
        const { OK, AVISO } = Dependencias;
        if (!servico.suportado()) {
            return [OK, 'serviço', 'só há serviço no macOS — aqui a tela sobe com npm start'];
        }
        const e = servico.estado(this.raiz);
        if (!e.instalado) {
            return [AVISO, 'serviço não instalado', 'sem ele a tela morre com o terminal: node instalacao/gatilhos.mjs --add'];
        }
        const node = this.nodeDoPlist(e.plist);
        if (node && !existsSync(node)) {
            return [AVISO, 'serviço', `o node gravado nele sumiu (${node}): node instalacao/gatilhos.mjs --add`];
        }
        if (!e.carregado) {
            return [AVISO, 'serviço instalado e parado', 'o launchd não o carregou: node instalacao/gatilhos.mjs --add'];
        }
        const peloServico = process.env.XPC_SERVICE_NAME === e.rotulo;
        return [OK, `serviço ${e.rotulo} · sobe no login e volta se cair`,
            this.naTela && !peloServico ? 'esta tela não é a do serviço: foi aberta à mão e morre com o terminal' : ''];
    }

    nodeDoPlist(caminho) {
        try {
            return (readFileSync(caminho, 'utf8').match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/) || [])[1] || null;
        } catch {
            return null;
        }
    }

    // O app guarda node, clone e porta na construção: trocar de node ou dar `git pull` não o atualiza.
    app() {
        const { OK, AVISO } = Dependencias;
        const app = appWindows.suportado() ? appWindows : appMac;
        if (!app.suportado()) {
            return [OK, 'app', 'há app para macOS e Windows — aqui a tela abre no navegador'];
        }
        const e = app.estado(this.raiz);
        if (!e.instalado || !e.meu) {
            const falta = app.requisitoFaltando();
            return [AVISO, e.instalado ? `app de outro clone (${e.clone})` : 'app não instalado',
                falta ? `opcional: ${falta}` : 'opcional: node instalacao/gatilhos.mjs --app'];
        }
        if (e.nodeExiste === false) {
            return [AVISO, 'app', `o node gravado nele sumiu (${e.node}): node instalacao/gatilhos.mjs --app`];
        }
        if (e.porta !== e.portaDaTela) {
            return [AVISO, 'app', `abre a porta ${e.porta}, e a tela sobe na ${e.portaDaTela}: node instalacao/gatilhos.mjs --app`];
        }
        if (e.desatualizado) {
            return [AVISO, 'app', `o fonte do app mudou desde a construção (de ${e.commit}): node instalacao/gatilhos.mjs --app`];
        }
        return [OK, `app · porta ${e.porta}`, ''];
    }

    async porta() {
        const { OK, AVISO } = Dependencias;
        if (process.platform === 'win32') {
            return [OK, 'porta 4100', 'não conferida no Windows (sem lsof) — se estiver ocupada, a tela avisa ao subir'];
        }
        const usada = await this.cmd('lsof', ['-nP', '-iTCP:4100', '-sTCP:LISTEN']);
        return [usada ? AVISO : OK, 'porta 4100',
            usada ? 'já em uso: suba com PORT=4200 npm start' : ''];
    }
}

// Confere os pré-requisitos e diz o que falta. Um script que descobre vale mais que uma lista que
// envelhece: se o `gh` sumir do PATH, a lista continua dizendo que está tudo certo.
//
// uso: node instalacao/verificar.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aplicarEnv } from '../lib/env.mjs';
import { caminhoSettings, lerSettings, jaRegistrados, outrosClones } from '../lib/gatilhos.mjs';
import * as appMac from '../lib/app.mjs';
import * as appWindows from '../lib/app-windows.mjs';

// O `.env` entra antes de resolver a raiz: é lá que o portão da primeira abertura grava a pasta
// escolhida, e sem isto o verificador conferia uma raiz diferente da que a tela usa.
aplicarEnv();

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKSPACE = process.env.QUALIDADE_WORKSPACE || dirname(RAIZ);
const OK = '  ok   ';
const FALTA = '  FALTA';
const AVISO = '  aviso';

class Verificar {
    cmd(exec, args) {
        try {
            return execFileSync(exec, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        } catch {
            return null;
        }
    }

    // O piso sai do `engines.node`, não de um número escrito aqui: com os dois, esta checagem
    // aprovava 20.11 enquanto o projeto já exigia 22.5.0 — e a quebra só aparecia no banco.
    node() {
        const piso = this.pisoDoNode();
        const serve = this.compararVersao(process.versions.node, piso) >= 0;
        return [serve ? OK : FALTA, `node ${process.versions.node}`,
            serve ? '' : `precisa de ${piso}+ — o estado usa o \`node:sqlite\` embutido, que não`
                + ' existe antes disso; sem ele a tela sobe e quebra no primeiro acesso ao banco'];
    }

    // Sem `engines` legível o piso ainda é conhecido: devolver 0 aqui faria a checagem aprovar tudo.
    pisoDoNode() {
        try {
            const engines = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8')).engines || {};
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

    git() {
        const v = this.cmd('git', ['--version']);
        return [v ? OK : FALTA, v || 'git', v ? '' : 'obrigatório: tudo parte de git diff'];
    }

    gh() {
        const v = this.cmd('gh', ['--version']);
        if (!v) {
            return [AVISO, 'gh (GitHub CLI)', 'sem ele: nada de PR, base observada nem checks'];
        }
        const auth = this.cmd('gh', ['auth', 'status']) !== null;
        return [auth ? OK : AVISO, v.split('\n')[0], auth ? '' : 'instalado mas não autenticado: rode `gh auth login`'];
    }

    workspace() {
        if (!existsSync(WORKSPACE)) {
            return [FALTA, WORKSPACE, 'pasta não existe — aponte QUALIDADE_WORKSPACE'];
        }
        const repos = readdirSync(WORKSPACE, { withFileTypes: true })
            .filter(d => d.isDirectory() && existsSync(join(WORKSPACE, d.name, '.git'))).length;
        return [repos ? OK : AVISO, `${WORKSPACE} (${repos} repo(s) git)`,
            repos ? '' : 'nenhum repo git aqui: a tela vai abrir vazia'];
    }

    // A ferramenta não traz linter: usa o de cada repo. Sem nenhum, o cartão de lint fica cinza.
    linters() {
        if (!existsSync(WORKSPACE)) {
            return [FALTA, 'linters', 'workspace inválido'];
        }
        let eslint = 0;
        let ruff = 0;
        for (const d of readdirSync(WORKSPACE, { withFileTypes: true })) {
            if (!d.isDirectory()) {
                continue;
            }
            const raiz = join(WORKSPACE, d.name);
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
        const tem = existsSync(join(RAIZ, 'vendor/acorn.mjs'));
        return [tem ? OK : FALTA, 'vendor/acorn.mjs', tem ? '' : 'sem o parser não há análise de código'];
    }

    envStg() {
        const tem = existsSync(join(RAIZ, '.env'));
        return [tem ? OK : AVISO, '.env (consulta ao Mongo de stage)',
            tem ? '' : 'opcional: sem ele o cartão de índices não confirma o plano de execução'];
    }

    // Confere se o hook aponta para ESTE clone, não se existe algum `gate.mjs` no arquivo: com dois
    // clones lado a lado, o `includes('gate.mjs')` dava ok para o install novo por causa do antigo
    // — check que responde ok sem o gatilho estar ligado é pior que check nenhum.
    hook() {
        const caminho = caminhoSettings(WORKSPACE);
        if (!existsSync(caminho)) {
            return [AVISO, 'hook', `sem ${relative(WORKSPACE, caminho)} (opcional: node instalacao/gatilhos.mjs --add)`];
        }
        let settings;
        try {
            settings = lerSettings(caminho).settings;
        } catch (e) {
            return [AVISO, 'hook', e.message];
        }
        const meus = jaRegistrados(settings, RAIZ);
        const outros = outrosClones(settings, RAIZ);
        if (meus.length === 3) {
            return [OK, 'hook deste clone registrado',
                outros.length ? `também há ${outros.length} de outro clone — a rotina chega duas vezes` : ''];
        }
        const detalhe = outros.length
            ? `há hook de ${outros[0]}, mas não deste clone — ligue com node instalacao/gatilhos.mjs --add`
            : 'opcional: sem o hook a rotina de fim não é injetada sozinha (node instalacao/gatilhos.mjs --add)';
        return [AVISO, meus.length ? `hook parcial (${meus.length}/3)` : 'hook não registrado', detalhe];
    }

    // O app guarda node, clone e porta na construção: trocar de node ou dar `git pull` não o atualiza.
    app() {
        const app = appWindows.suportado() ? appWindows : appMac;
        if (!app.suportado()) {
            return [OK, 'app', 'há app para macOS e Windows — aqui a tela abre no navegador'];
        }
        const e = app.estado(RAIZ);
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

    porta() {
        if (process.platform === 'win32') {
            return [OK, 'porta 4100', 'não conferida no Windows (sem lsof) — se estiver ocupada, a tela avisa ao subir'];
        }
        const usada = this.cmd('lsof', ['-nP', '-iTCP:4100', '-sTCP:LISTEN']);
        return [usada ? AVISO : OK, 'porta 4100',
            usada ? 'já em uso: suba com PORT=4200 npm start' : ''];
    }

    executar() {
        const checagens = [
            ['obrigatório', this.node()], ['obrigatório', this.git()], ['obrigatório', this.acorn()],
            ['obrigatório', this.workspace()],
            ['recomendado', this.gh()], ['recomendado', this.linters()],
            ['opcional', this.envStg()], ['opcional', this.hook()], ['opcional', this.app()], ['opcional', this.porta()]
        ];
        let faltando = 0;
        let grupo = '';
        for (const [nivel, [marca, nome, nota]] of checagens) {
            if (nivel !== grupo) {
                grupo = nivel;
                console.log(`\n${nivel}`);
            }
            console.log(`${marca}  ${nome}${nota ? `\n         ↳ ${nota}` : ''}`);
            if (marca === FALTA) {
                faltando++;
            }
        }
        console.log(faltando
            ? `\n${faltando} pré-requisito(s) obrigatório(s) faltando.`
            : '\nPronto para rodar: npm start');
        return faltando === 0;
    }
}

process.exit(new Verificar().executar() ? 0 : 1);

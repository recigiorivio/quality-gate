// Confere os pré-requisitos e diz o que falta. Um script que descobre vale mais que uma lista que
// envelhece: se o `gh` sumir do PATH, a lista continua dizendo que está tudo certo.
//
// uso: node instalacao/verificar.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

    hook() {
        for (const rel of ['.claude/settings.json', '../.claude/settings.json']) {
            const caminho = join(WORKSPACE, rel);
            if (!existsSync(caminho)) {
                continue;
            }
            const texto = this.cmd('cat', [caminho]) || '';
            const ligado = texto.includes('gate.mjs');
            return [ligado ? OK : AVISO, `hook em ${rel}`,
                ligado ? '' : 'opcional: sem o hook a rotina de fim não é injetada sozinha'];
        }
        return [AVISO, 'hook', 'nenhum .claude/settings.json encontrado (opcional)'];
    }

    porta() {
        const usada = this.cmd('lsof', ['-nP', '-iTCP:4100', '-sTCP:LISTEN']);
        return [usada ? AVISO : OK, 'porta 4100',
            usada ? 'já em uso: suba com PORT=4200 npm start' : ''];
    }

    executar() {
        const checagens = [
            ['obrigatório', this.node()], ['obrigatório', this.git()], ['obrigatório', this.acorn()],
            ['obrigatório', this.workspace()],
            ['recomendado', this.gh()], ['recomendado', this.linters()],
            ['opcional', this.envStg()], ['opcional', this.hook()], ['opcional', this.porta()]
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

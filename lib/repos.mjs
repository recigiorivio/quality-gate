// Quais repos entram na comparação de implantação, e por qual par de branches.
//
// Antes isto era uma convenção enterrada no código: `origin/main...origin/stage`, fixo. O `git`
// falhava em quem não tivesse os dois refs, o `catch` devolvia `null` e o repo sumia da fila sem
// dizer nada. Medido em 10/09/2026: das 51 pastas com `.git`, 20 caíam fora — e quatro delas por
// engano, não por não terem deploy. `crohc-drools-model` e `integration-loader-fsfx` integram por
// `desenv → master`; `drmarvin-integration-client` tem `stage`, mas o destino é `master`; e o
// `drmarvin-core-js`, a biblioteca que os outros consomem, usa `desenv → main`.
//
// Agora é dado: detectado sozinho, e editável na tela. Uma entrada `manual` nunca é sobrescrita
// pela detecção — quem corrigiu à mão corrigiu por saber algo que o palpite não sabe.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE } from './diff.mjs';
import { ler, gravar } from './estado.mjs';

const execFileAsync = promisify(execFile);
// `QUALIDADE_ESTADO` existe para o teste: a suíte apontava para o arquivo de produção e
// esvaziou a escolha de repos do usuário três vezes, mesmo restaurando no `finally` —
// restauração some junto quando o teste falha no meio. Isolar o diretório resolve na raiz.
const CATALOGO = join(process.env.QUALIDADE_ESTADO
    || dirname(dirname(fileURLToPath(import.meta.url))), 'repos.json');
// Ordem de preferência, não alfabética: onde existe mais de uma, a primeira é a que o time usa
// como integração. `stage` na frente porque é o padrão declarado do workspace.
const ORIGENS = ['stage', 'desenv', 'develop', 'homolog', 'hml'];
const DESTINOS = ['main', 'master', 'producao', 'prod'];

export class Repos {
    async git(projeto, ...args) {
        try {
            const { stdout } = await execFileAsync('git', ['-C', join(WORKSPACE, projeto), ...args],
                { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
            return stdout.trim();
        } catch {
            return null;
        }
    }

    pastas() {
        return readdirSync(WORKSPACE, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.name.startsWith('.')
                && existsSync(join(WORKSPACE, d.name, '.git')))
            .map(d => d.name)
            .sort();
    }

    // O destino sai do `origin/HEAD` — o que o próprio remoto declara como padrão — MENOS quando
    // ele aponta para uma branch de integração, que é o caso de 4 repos daqui (`jungle-monorepo`,
    // `rivio-deployment-cortex`, `alerts-manager-rivio-one`, `backend-core-rivio-one` têm
    // `origin/HEAD → origin/stage`). Aceitar isso fazia `stage` virar destino e não sobrava origem:
    // os quatro sumiam da fila, sendo que três deles estavam nela antes.
    async detectarUm(projeto) {
        const refs = await this.git(projeto, 'branch', '-r', '--format=%(refname:short)');
        if (refs === null) {
            return { projeto, origem: null, destino: null, motivo: 'git não respondeu neste repo' };
        }
        const tem = new Set(refs.split('\n').map(r => r.trim()).filter(Boolean));
        const cabeca = await this.git(projeto, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
        const integracao = new Set(ORIGENS.map(o => `origin/${o}`));
        const destino = [integracao.has(cabeca) ? null : cabeca, ...DESTINOS.map(d => `origin/${d}`)]
            .find(d => d && tem.has(d)) || null;
        const origem = ORIGENS.map(o => `origin/${o}`).find(o => tem.has(o) && o !== destino) || null;
        if (!destino || !origem) {
            return {
                projeto, origem, destino,
                motivo: !destino ? 'sem branch de destino (main/master) no remoto'
                    : 'sem branch de origem (stage/desenv/…) no remoto'
            };
        }
        return { projeto, origem, destino, motivo: null };
    }

    // Detecta tudo e funde com o que já está gravado. Manual vence sempre; a remoção também é
    // gravada (`ativo: false`), senão a próxima detecção traria de volta o que a pessoa tirou.
    async detectar() {
        const guardado = new Map(this.listar().map(r => [r.projeto, r]));
        const achados = await Promise.all(this.pastas().map(p => this.detectarUm(p)));
        const repos = achados.map(a => {
            const antes = guardado.get(a.projeto);
            if (antes?.fonte === 'manual') {
                return antes;
            }
            return {
                projeto: a.projeto,
                origem: a.origem,
                destino: a.destino,
                fonte: 'detectado',
                // Linha detectada é DERIVADA: `ativo` é só "achei o par", recalculado toda vez.
                // Honrar o `false` de uma detecção anterior confundia "a pessoa desligou" com "da
                // outra vez eu não achei" — e foi o que manteve 4 repos fora depois de eu corrigir
                // a detecção deles. Decisão de gente mora em `fonte: 'manual'`, e essa sim é
                // devolvida intacta no `if` acima, sem passar por aqui.
                ativo: Boolean(a.origem && a.destino),
                motivo: a.motivo
            };
        });
        // Entrada manual de repo que não está mais no disco não é apagada: sumiu a pasta, não a
        // decisão, e apagar em silêncio é o que esta classe inteira existe para não fazer.
        for (const [projeto, r] of guardado) {
            if (r.fonte === 'manual' && !repos.some(x => x.projeto === projeto)) {
                repos.push({ ...r, motivo: 'a pasta não existe mais no workspace' });
            }
        }
        repos.sort((a, b) => a.projeto.localeCompare(b.projeto));
        gravar(CATALOGO, { detectadoEm: new Date().toISOString(), repos });
        return repos;
    }

    listar() {
        return ler(CATALOGO, { repos: [] }).repos || [];
    }

    detectadoEm() {
        return ler(CATALOGO, {}).detectadoEm || null;
    }

    // O que a fila de implantação de fato percorre.
    ativos() {
        return this.listar().filter(r => r.ativo && r.origem && r.destino);
    }

    par(projeto) {
        const r = this.listar().find(x => x.projeto === projeto);
        return r?.origem && r?.destino ? { origem: r.origem, destino: r.destino } : null;
    }

    // Vem da tela: a lista inteira, já editada. Marca como `manual` só o que MUDOU em relação ao
    // detectado — assim uma edição de um repo não congela os outros 50 contra a próxima detecção.
    salvar(entradas) {
        const antes = new Map(this.listar().map(r => [r.projeto, r]));
        const repos = entradas.map(e => {
            const projeto = String(e.projeto || '').trim();
            const origem = e.origem ? String(e.origem).trim() : null;
            const destino = e.destino ? String(e.destino).trim() : null;
            const velho = antes.get(projeto);
            // Ligar/desligar também é edição: sem contar o `ativo`, desmarcar um repo na tela não
            // virava `manual` e a próxima detecção o ligava de volta.
            const ativo = Boolean(e.ativo) && Boolean(origem && destino);
            const mudou = !velho || velho.origem !== origem || velho.destino !== destino
                || velho.ativo !== ativo;
            return {
                projeto, origem, destino,
                fonte: mudou || velho?.fonte === 'manual' ? 'manual' : 'detectado',
                ativo,
                motivo: origem && destino ? null : 'sem par de branches'
            };
        }).filter(r => r.projeto);
        repos.sort((a, b) => a.projeto.localeCompare(b.projeto));
        gravar(CATALOGO, { ...ler(CATALOGO, {}), repos });
        return repos;
    }
}

// Quais repos entram na comparação de implantação, e por qual par de branches.
//
// Antes isto era uma convenção enterrada no código: `origin/main...origin/stage`, fixo. O `git`
// falhava em quem não tivesse os dois refs, o `catch` devolvia `null` e o repo sumia da fila sem
// dizer nada. Medido em 10/09/2026: das 51 pastas com `.git`, 20 caíam fora — e quatro delas por
// engano, não por não terem deploy. `crohc-drools-model` e `drmarvin-loader-plugin-tasy` integram por
// `desenv → master`; `drmarvin-integration-client` tem `stage`, mas o destino é `master`; e o
// `drmarvin-core-js`, a biblioteca que os outros consomem, usa `desenv → main`.
//
// Agora é dado: detectado sozinho, e editável na tela. Uma entrada `manual` nunca é sobrescrita
// pela detecção — quem corrigiu à mão corrigiu por saber algo que o palpite não sabe.
//
// O catálogo mora na tabela `repos` do `lib/db.mjs`, e não mais num JSON, por causa desse
// invariante. Como blob, "linha manual a detecção não encosta" era fusão em JS de duas listas
// inteiras, e eu a implementei errado duas vezes no mesmo dia. Como linha, é o `WHERE
// repos.fonte = 'detectado'` do upsert em `gravarDetectados`: uma instrução que não CONSEGUE
// tocar linha manual. Aqui sobrou só a detecção — falar com o `git` e decidir o par de branches.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE } from './diff.mjs';
import { repos as catalogo, transacao } from './db.mjs';
import { INTEGRACAO, PRODUCAO, INTERMEDIARIAS } from './branches.mjs';

const execFileAsync = promisify(execFile);

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

    // O destino sai do `origin/HEAD`, menos quando ele aponta para a integração ou o degrau: aceitar
    // `origin/HEAD → origin/stage` fez 4 repos sumirem da fila em 10/09/2026, sem origem que sobrasse.
    async detectarUm(projeto) {
        const refs = await this.git(projeto, 'branch', '-r', '--format=%(refname:short)');
        if (refs === null) {
            return { projeto, origem: null, destino: null, motivo: 'git não respondeu neste repo' };
        }
        const tem = new Set(refs.split('\n').map(r => r.trim()).filter(Boolean));
        const cabeca = await this.git(projeto, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
        const naoDestino = new Set([...INTEGRACAO, ...INTERMEDIARIAS].map(o => `origin/${o}`));
        const destino = [naoDestino.has(cabeca) ? null : cabeca, ...PRODUCAO.map(d => `origin/${d}`)]
            .find(d => d && tem.has(d)) || null;
        const origem = INTEGRACAO.map(o => `origin/${o}`).find(o => tem.has(o) && o !== destino) || null;
        if (!destino || !origem) {
            return {
                projeto, origem, destino,
                motivo: !destino ? 'sem branch de destino (main/master) no remoto'
                    : `sem branch de origem (${INTEGRACAO.join('/')}) no remoto`
            };
        }
        return { projeto, origem, destino, motivo: null };
    }

    // `ativo` não é enviado: linha detectada é DERIVADA, e honrar o `false` de uma detecção
    // anterior confundia "a pessoa desligou" com "da outra vez eu não achei" — 4 repos ficaram fora.
    async detectar() {
        const achados = await Promise.all(this.pastas().map(p => this.detectarUm(p)));
        return catalogo.gravarDetectados(achados);
    }

    listar() {
        return catalogo.listar();
    }

    detectadoEm() {
        return catalogo.detectadoEm();
    }

    // O que a fila de implantação de fato percorre.
    ativos() {
        return catalogo.ativos();
    }

    par(projeto) {
        return catalogo.par(projeto);
    }

    // A escrita que a tela usa: uma linha, nomeada. Não alcança os outros 50 repos, e a aba velha
    // não tem como ressuscitar a cópia que a outra aba acabou de mudar.
    salvarUm(entrada) {
        return transacao(() => {
            const projeto = String(entrada.projeto || '').trim();
            return catalogo.definir(this._comFonte(entrada, catalogo.obter(projeto)));
        });
    }

    // ⚠ DESTRUTIVO: repo ausente da lista é APAGADO. Só para trocar o catálogo inteiro de
    // propósito — nunca para o botão de salvar, que manda a cópia velha da aba e desfaz a da outra.
    substituirTudo(entradas) {
        return transacao(() => {
            const antes = new Map(catalogo.listar().map(r => [r.projeto, r]));
            const lista = entradas
                .map(e => this._comFonte(e, antes.get(String(e.projeto || '').trim())))
                .filter(r => r.projeto);
            catalogo.salvarVarias(lista);
            const vieram = new Set(lista.map(r => r.projeto));
            for (const projeto of antes.keys()) {
                if (!vieram.has(projeto)) {
                    catalogo.remover(projeto);
                }
            }
            return catalogo.listar();
        });
    }

    remover(projeto) {
        return catalogo.remover(projeto);
    }

    // Marca como `manual` só o que MUDOU — assim editar um repo não congela os outros 50 contra a
    // próxima detecção. A `fonte` do cliente é ignorada: é o que ele leu, não uma decisão.
    _comFonte(entrada, velho) {
        const projeto = String(entrada.projeto || '').trim();
        const origem = entrada.origem ? String(entrada.origem).trim() : null;
        const destino = entrada.destino ? String(entrada.destino).trim() : null;
        // Ligar/desligar também é edição: sem contar o `ativo`, desmarcar um repo na tela não
        // virava `manual` e a próxima detecção o ligava de volta.
        const ativo = Boolean(entrada.ativo) && Boolean(origem && destino);
        const mudou = !velho || velho.origem !== origem || velho.destino !== destino
            || velho.ativo !== ativo;
        return {
            projeto, origem, destino,
            fonte: mudou || velho?.fonte === 'manual' ? 'manual' : 'detectado',
            ativo,
            motivo: origem && destino ? null : 'sem par de branches'
        };
    }
}

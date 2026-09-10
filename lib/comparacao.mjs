// A comparação que TODA a tela usa: o diff, as checagens, a análise e o lint.
//
// **Quem decide é o agente, não a ferramenta.** A tentativa de automatizar falhou por um motivo
// concreto: num chamado real havia 22 branches em 12 repos e, num único repo, 7 PRs em 7 branches —
// seis mescladas e a aberta sendo outra. Topologia adivinhava e errava (mostrava 0 arquivo onde a PR
// mostrava 27), e escolher "a PR da branch com o nome do chamado" pegava a PR mesclada errada.
//
// Então a rotina de fim de trabalho grava a decisão, e aqui só se obedece. Sem decisão, cai no local
// (branch × base por topologia) e a tela DIZ que ninguém decidiu — porque o palpite não anunciado
// foi o que criou o problema.
//
// O que mudou: a decisão era uma chave de `comparacoes.json`, lido e regravado INTEIRO. Quem grava
// são dois processos — o servidor e o `ferramentas/comparacao.mjs definir` que o agente roda — e
// ler-alterar-gravar entre dois processos perde a escrita do outro sem erro nenhum. Agora cada
// decisão é uma linha de `decisoes` e cada escrita é um upsert só dela (`lib/db.mjs`).
//
// `versao` continua entrando nas chaves de cache do servidor, senão a resposta velha seguiria sendo
// servida depois de o agente decidir — uma decisão invisível para o servidor vivo já custou um
// REINÍCIO do servidor no meio da corrida. Era o mtime do arquivo, relido a cada chamada; virou o
// contador do domínio, que também sobe quando quem gravou foi o outro processo.
//
// Não há mais estado por instância: o banco é o do diretório em `QUALIDADE_ESTADO` (a raiz do
// projeto, ou o temporário da suíte), resolvido a cada abertura.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { decisoes, versao } from './db.mjs';
import { Diff, WORKSPACE } from './diff.mjs';

export class Comparacao {
    get versao() {
        return versao('decisoes');
    }

    atuais() {
        return decisoes.mapa();
    }

    _raiz(projeto) {
        return projeto.startsWith('/') ? projeto : join(WORKSPACE, projeto);
    }

    // Igualdade, não prefixo: o `startsWith(chamado + '|')` de antes fazia `UND-16` trazer a decisão
    // de `UND-1638`.
    listar(chamado = null) {
        return decisoes.listar(chamado);
    }

    definir(chamado, projeto, decisao) {
        return decisoes.definir(chamado, projeto, decisao);
    }

    // Órfã = decisão de um par (chamado, repo) em que não existe mais branch nenhuma com o ID, nem
    // local nem no origin. A tabela só cresce; isto é o que separa histórico de lixo.
    orfas() {
        return this.listar().filter(d => {
            try {
                const saida = execFileSync('git', ['-C', this._raiz(d.projeto), 'branch', '-a', '--list', `*${d.chamado}*`],
                    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
                return !saida.trim();
            } catch {
                return true;   // repo que não existe mais no disco também é órfã
            }
        });
    }

    remover(chamado, projeto) {
        return decisoes.remover(chamado, projeto);
    }

    // Devolve `{ diff, base, alvo, via, decisao }`. `via` é o que a tela mostra: `pr` e `branch` são
    // decisão do agente; `local` é palpite declarado; `informada` é base passada na URL.
    resolver(projeto, ref = '', baseForcada = null, chamado = null) {
        if (baseForcada && baseForcada !== '-') {
            const d = new Diff(projeto, ref);
            return { diff: d, base: d.resolverBase(baseForcada), alvo: ref, via: 'informada' };
        }
        const decidida = this._pelaDecisao(projeto, chamado);
        if (decidida && !decidida.erro) {
            return decidida;
        }
        const d = new Diff(projeto, ref);
        return { diff: d, base: d.resolverBase(), alvo: ref, via: 'local', erroDaDecisao: decidida?.erro || null };
    }

    // Três fontes possíveis, e é o agente que diz qual vale: a comparação da PR (base…head gravados
    // por ela), a branch contra o destino (`stage`), ou uma branch/base explícitas. `situacao` é o
    // veredito dele sobre o repo — resolvido ou aberto — e não é recalculado aqui.
    _pelaDecisao(projeto, chamado) {
        const dec = decisoes.obter(chamado, projeto);
        if (!dec) {
            return null;
        }
        const alvo = dec.head || dec.branch;
        // Decisão que não se aplica (branch apagada, base que não existe neste repo) devolve o
        // MOTIVO, não `null`: cair no local em silêncio esconde exatamente o que precisa ser visto.
        if (!alvo || !this._existe(projeto, alvo)) {
            return { erro: `a decisão aponta para '${alvo}', que não existe neste repo` };
        }
        const base = dec.via === 'pr' && dec.base && dec.head
            ? this._mergeBase(projeto, dec.base, dec.head)
            : this._mergeBase(projeto, dec.base || 'origin/stage', alvo);
        if (!base) {
            return { erro: `sem merge-base entre '${dec.base || 'origin/stage'}' e '${alvo}' neste repo` };
        }
        // Decisão por branch/stage num repo PARADO nessa branch compara a árvore de trabalho, não o
        // ref: o trabalho ainda não commitado é justamente o que se quer ver, e comparar o ref dava
        // 0 arquivo em 4 repos com 25 arquivos sujos. PR é foto fixa (head oid) e continua como está.
        const naBranch = dec.via !== 'pr' && this._branchAtual(projeto) === alvo;
        const d = new Diff(projeto, naBranch ? '' : alvo);
        d.baseNome = dec.via === 'pr'
            ? `PR #${dec.pr} → ${dec.destino || 'base'}`
            : `${dec.branch} → ${dec.base || 'origin/stage'}`;
        d.mesclado = dec.situacao === 'resolvido';
        d.comoSoube = 'decisao';
        return { diff: d, base, alvo, via: dec.via || 'branch', decisao: dec };
    }

    _branchAtual(projeto) {
        try {
            return execFileSync('git', ['-C', this._raiz(projeto), 'rev-parse', '--abbrev-ref', 'HEAD'],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        } catch {
            return null;
        }
    }

    _existe(projeto, rev) {
        try {
            execFileSync('git', ['-C', this._raiz(projeto), 'rev-parse', '--verify', '-q', rev],
                { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    }

    _mergeBase(projeto, a, b) {
        try {
            return execFileSync('git', ['-C', this._raiz(projeto), 'merge-base', a, b],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
        } catch {
            return null;
        }
    }
}

export default new Comparacao();

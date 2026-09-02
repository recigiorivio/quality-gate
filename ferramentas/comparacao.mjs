// Grava qual é a comparação certa de um chamado num repo. É a rotina de fim de trabalho que decide;
// esta ferramenta só persiste a decisão para a tela obedecer.
//
// Existe porque automatizar falhou: num chamado real, 7 PRs em 7 branches no mesmo repo, seis
// mescladas e a aberta sendo outra. Nenhuma regra local distingue "a PR que importa" das outras.
//
// uso:
//   node ferramentas/comparacao.mjs listar [CHAMADO]
//   node ferramentas/comparacao.mjs definir <CHAMADO> <projeto> --pr=856 [--resolvido|--aberto]
//   node ferramentas/comparacao.mjs definir <CHAMADO> <projeto> --stage [--branch=X]
//   node ferramentas/comparacao.mjs definir <CHAMADO> <projeto> --branch=X --base=origin/main
//   node ferramentas/comparacao.mjs remover <CHAMADO> <projeto>

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Comparacao } from '../lib/comparacao.mjs';
import { WORKSPACE } from '../lib/diff.mjs';

const c = new Comparacao();
const args = process.argv.slice(2);
const flag = nome => {
    const achado = args.find(a => a.startsWith(`--${nome}=`));
    return achado ? achado.slice(nome.length + 3) : null;
};
const soltos = args.filter(a => !a.startsWith('--'));
const [acao, chamado, projeto] = soltos;
const json = args.includes('--json');

function doGh(projeto, pr) {
    const bruto = execFileSync('gh', ['pr', 'view', String(pr), '--json',
        'number,state,baseRefName,headRefName,baseRefOid,headRefOid,title,url'],
    { cwd: join(WORKSPACE, projeto), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const p = JSON.parse(bruto);
    return {
        pr: p.number, estado: p.state, destino: p.baseRefName, branch: p.headRefName,
        base: p.baseRefOid, head: p.headRefOid, titulo: p.title, url: p.url
    };
}

function morrer(msg) {
    console.error(msg);
    process.exit(1);
}

if (acao === 'listar') {
    const lista = c.listar(chamado || null);
    if (json) {
        console.log(JSON.stringify({ decisoes: lista }, null, 2));
    } else if (!lista.length) {
        console.log('nenhuma comparação definida — a tela vai usar o local e dizer isso');
    } else {
        for (const d of lista) {
            const como = d.via === 'pr' ? `PR #${d.pr} → ${d.destino}` : `${d.branch} × ${d.base}`;
            console.log(`${(d.situacao || '?').padEnd(10)} ${d.chamado}  ${d.projeto.padEnd(30)} ${como}${d.nota ? `  — ${d.nota}` : ''}`);
        }
    }
} else if (acao === 'definir') {
    if (!chamado || !projeto) {
        morrer('uso: definir <CHAMADO> <projeto> (--pr=N | --stage | --branch=X) [--resolvido|--aberto]');
    }
    const pr = flag('pr');
    const branch = flag('branch');
    const contraStage = args.includes('--stage');
    if (!pr && !branch && !contraStage) {
        morrer('informe a fonte: --pr=N, --stage, ou --branch=X');
    }
    let decisao;
    if (pr) {
        try {
            decisao = { via: 'pr', ...doGh(projeto, pr) };
        } catch (e) {
            morrer(`não consegui ler a PR #${pr} em ${projeto}: ${(e.stderr || e.message).toString().trim().split('\n')[0]}`);
        }
    } else {
        decisao = { via: contraStage ? 'stage' : 'branch', branch: branch || chamado, base: flag('base') || 'origin/stage' };
    }
    // Sem `--resolvido`/`--aberto`, o estado da PR responde; fora da PR não há o que inferir, então
    // fica `aberto` — dizer "resolvido" sem ninguém ter dito é o palpite que a gente tirou daqui.
    decisao.situacao = args.includes('--resolvido') ? 'resolvido'
        : args.includes('--aberto') ? 'aberto'
            : (decisao.estado === 'MERGED' ? 'resolvido' : 'aberto');
    const nota = flag('nota');
    if (nota) {
        decisao.nota = nota;
    }
    const gravada = c.definir(chamado, projeto, decisao);
    console.log(json ? JSON.stringify(gravada, null, 2)
        : `gravado: ${chamado} ${projeto} → ${gravada.via === 'pr' ? `PR #${gravada.pr}` : `${gravada.branch} × ${gravada.base}`} · ${gravada.situacao}`);
} else if (acao === 'remover') {
    if (!chamado || !projeto) {
        morrer('uso: remover <CHAMADO> <projeto>');
    }
    console.log(c.remover(chamado, projeto) ? 'removido' : 'não havia decisão para esse par');
} else {
    console.log(`uso:
  node ferramentas/comparacao.mjs listar [CHAMADO]
  node ferramentas/comparacao.mjs definir <CHAMADO> <projeto> --pr=856 [--resolvido|--aberto]
  node ferramentas/comparacao.mjs definir <CHAMADO> <projeto> --stage [--branch=X] [--aberto]
  node ferramentas/comparacao.mjs definir <CHAMADO> <projeto> --branch=X --base=origin/main
     --nota="por que esta é a comparação certa"
  node ferramentas/comparacao.mjs remover <CHAMADO> <projeto>`);
}

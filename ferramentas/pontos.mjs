// Pontos de atenção da IA. O estado vive no `qualidade.db` (lib/db.mjs), não mais num JSON: este
// arquivo é CLI que o agente roda E é importado pelo servidor, e os dois liam o arquivo inteiro,
// mutavam e regravavam — `add` pelo terminal durante um `remover` pela tela perdia uma das duas
// operações sem erro nenhum. O teto de 10 continua sendo a regra de produto, agora também num
// trigger do banco.
//
// uso: node qualidade/ferramentas/pontos.mjs listar [--json]
//      node qualidade/ferramentas/pontos.mjs add <id> <severidade> <titulo> <detalhe> [chamado] [projeto]
//      node qualidade/ferramentas/pontos.mjs remover <id>

import { pontos } from '../lib/db.mjs';

export class Pontos {
    get teto() {
        return pontos.teto;
    }

    listar() {
        return pontos.listar();
    }

    // Os que valem para o que está na tela: do chamado, do projeto, ou gerais (campos nulos).
    para(chamado, projeto) {
        return pontos.para(chamado ?? null, projeto ?? null);
    }

    // Com o teto cheio, empurra o mais antigo de menor severidade; se só houver 'atencao', lança.
    add(ponto) {
        return pontos.gravar(ponto);
    }

    remover(id) {
        return pontos.remover(id);
    }
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const p = new Pontos();
    const [acao, ...args] = process.argv.slice(2).filter(a => a !== '--json');
    const comoJson = process.argv.includes('--json');
    if (acao === 'add') {
        const [id, severidade, titulo, detalhe, chamado, projeto] = args;
        const r = p.add({ id, severidade, titulo, detalhe, chamado: chamado || null, projeto: projeto || null });
        console.log(`gravado. total ${r.total}${r.descartados.length ? ` · descartado por teto: ${r.descartados.join(', ')}` : ''}`);
    } else if (acao === 'remover') {
        console.log(JSON.stringify(p.remover(args[0])));
    } else {
        const dados = { teto: p.teto, pontos: p.listar() };
        if (comoJson) {
            process.stdout.write(JSON.stringify(dados));
        } else {
            console.log(`${dados.pontos.length}/${dados.teto} pontos`);
            for (const x of dados.pontos) {
                const escopo = [x.chamado, x.projeto].filter(Boolean).join(' · ') || 'geral';
                console.log(`  [${x.severidade}] ${x.titulo}\n      ${escopo} · ${x.criadoEm}`);
            }
        }
    }
}

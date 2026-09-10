// O banco por fora da tela: o que a importação fez, o que tem lá dentro, e o dump para JSON.
//
// Existe porque o argumento que sustentou a migração de JSON para SQLite foi "o dado continua
// inspecionável", e `exportarJson()`/`relatorioImportacao()` não tinham UM chamador fora da suíte
// de teste — nem rota, nem comando. Promessa sem caminho alcançável não é promessa.
//
// O `exportar` grava a mesma forma que a importação lê: apontar `QUALIDADE_ESTADO` para a pasta
// exportada e abrir o banco lá reconstrói o conteúdo, e é isso que a suíte comprova.
//
// uso: node qualidade/ferramentas/banco.mjs importacoes [--json]
//      node qualidade/ferramentas/banco.mjs resumo [--json]
//      node qualidade/ferramentas/banco.mjs exportar [destino] [--json]

import {
    caminhoBanco, corridas, decisoes, exportarJson, fechar, pontos, relatorioImportacao, repos
} from '../lib/db.mjs';

export class Banco {
    importacoes() {
        return relatorioImportacao();
    }

    resumo() {
        return {
            banco: caminhoBanco(),
            decisoes: decisoes.contar(),
            repos: repos.contar(),
            pontos: pontos.contar(),
            corridas: corridas.contar(),
            importacoes: this.importacoes().length
        };
    }

    exportar(destino) {
        return destino ? exportarJson(destino) : exportarJson();
    }
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const json = args.includes('--json');
    const [acao, destino] = args.filter(a => !a.startsWith('--'));
    const b = new Banco();
    if (acao === 'importacoes') {
        const lista = b.importacoes();
        if (json) {
            process.stdout.write(JSON.stringify(lista));
        } else if (!lista.length) {
            console.log('nenhuma importação registrada — o banco nasceu vazio, sem JSON antigo ao lado');
        } else {
            for (const i of lista) {
                console.log(`${String(i.linhas).padStart(4)} linha(s)  ${i.em.slice(0, 19)}  ${i.arquivo}`
                    + `${i.observacao ? `\n            ↳ ${i.observacao}` : ''}`);
            }
        }
    } else if (acao === 'exportar') {
        const r = b.exportar(destino);
        console.log(json ? JSON.stringify(r)
            : `${r.arquivos.length} arquivo(s) em ${r.destino}\n`
                + `confira com: QUALIDADE_ESTADO=${r.destino} node ferramentas/banco.mjs resumo`);
    } else if (acao === 'resumo') {
        const r = b.resumo();
        console.log(json ? JSON.stringify(r)
            : `${r.banco}\n  ${r.decisoes} decisões · ${r.repos} repos · ${r.pontos} pontos`
                + ` · ${r.corridas} corridas · ${r.importacoes} importações`);
    } else {
        console.log(`uso:
  node ferramentas/banco.mjs importacoes [--json]   # o que entrou de cada JSON, e o que ficou fora
  node ferramentas/banco.mjs resumo [--json]        # quantas linhas há em cada tabela
  node ferramentas/banco.mjs exportar [destino]     # dump JSON (padrão: <estado>/exportado/)`);
    }
}

// Enquanto há conexão aberta o WAL deixa `qualidade.db-wal` e `-shm` ao lado do banco; fechar aqui
// faz o checkpoint e apaga os dois, e o próximo processo abre um diretório limpo.
fechar();

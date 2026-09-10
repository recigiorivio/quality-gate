// O que está em `stage` e ainda não foi para `main` — a fila de implantação, atravessando os repos.
//
// Dois passos, de propósito: `resumo()` é uma contagem por repo e responde quem está à frente;
// `detalhe(projeto)` é o caro e sai sob demanda, só para os repos que a pessoa escolher.
//
// A pergunta que a barra de chamados NÃO responde: ela olha o trabalho por chamado, e implantar é
// olhar por repo, o acumulado de vários chamados. Medido no workspace: 7 repos, 137 commits e 249
// arquivos esperando, de 11 chamados diferentes.
//
// A base é o merge-base, não `origin/main` cru: com dois pontos o diff mostraria também o que a
// `main` ganhou por fora (cherry-pick de correção urgente, que aqui é rotina) como se fosse remoção.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE } from './diff.mjs';

const execFileAsync = promisify(execFile);
const PADRAO_CHAMADO = /\b([A-Z]{2,5}-\d+)\b/g;
const ESCOLHIDOS = join(dirname(dirname(fileURLToPath(import.meta.url))), 'implantacao.json');

export class Implantacao {
    async git(projeto, ...args) {
        try {
            const { stdout } = await execFileAsync('git', ['-C', join(WORKSPACE, projeto), ...args],
                { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
            return stdout.trim();
        } catch {
            return null;
        }
    }

    repos() {
        return readdirSync(WORKSPACE, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.name.startsWith('.') && existsSync(join(WORKSPACE, d.name, '.git')))
            .map(d => d.name);
    }

    // Passo BARATO: uma contagem por repo, só para saber quem está à frente. O detalhe (log,
    // numstat, IDs, migrates) é caro e sai por repo, sob demanda — o workspace tem 22 repos com
    // stage à frente, um deles com 563 commits, e calcular todos de uma vez é trabalho jogado fora.
    async resumo(destino = 'origin/main', origem = 'origin/stage') {
        const achados = await Promise.all(this.repos().map(async projeto => {
            const contagem = await this.git(projeto, 'rev-list', '--left-right', '--count',
                `${destino}...${origem}`);
            if (!contagem) {
                return null;
            }
            const [atras, afrente] = contagem.split(/\s+/).map(Number);
            if (!afrente) {
                return null;
            }
            return { projeto, commits: afrente, atras, destino, origem };
        }));
        return achados.filter(Boolean).sort((a, b) => b.commits - a.commits);
    }

    // O caro, de um repo só: o que de fato entra na implantação.
    async detalhe(projeto, destino = 'origin/main', origem = 'origin/stage') {
        const base = await this.git(projeto, 'merge-base', destino, origem);
        if (!base) {
            return null;
        }
        const bruto = await this.git(projeto, 'log', `${base}..${origem}`, '--format=%h%x01%an%x01%cI%x01%s');
        if (!bruto) {
            return null;
        }
        const commits = bruto.split('\n').filter(Boolean).map(l => {
            const [hash, autor, data, titulo] = l.split('\x01');
            return { hash, autor, data, titulo };
        });
        const nomes = await this.git(projeto, 'diff', '--numstat', base, origem, '--');
        const arquivos = (nomes || '').split('\n').filter(Boolean).map(l => {
            const [mais, menos, ...resto] = l.split('\t');
            return { caminho: resto[resto.length - 1], adicionadas: Number(mais) || 0, removidas: Number(menos) || 0 };
        });
        const ids = [...new Set(commits.flatMap(c => c.titulo.match(PADRAO_CHAMADO) || []))].sort();
        return {
            projeto, base, destino, origem,
            commits: commits.length,
            listaDeCommits: commits,
            arquivos: arquivos.length,
            adicionadas: arquivos.reduce((s, a) => s + a.adicionadas, 0),
            removidas: arquivos.reduce((s, a) => s + a.removidas, 0),
            ids,
            autores: [...new Set(commits.map(c => c.autor))],
            // Sinais que mudam o peso da implantação e que ninguém lembra de procurar na pressa.
            migrates: arquivos.filter(a => /migrations?\//i.test(a.caminho)).map(a => a.caminho),
            pacote: arquivos.some(a => /(^|\/)package\.json$/.test(a.caminho)),
            // `desde`/`ate` não: o cache do servidor acrescenta um `desde` próprio (o instante em
            // que guardou) e sobrescreveria estes. Nome colidido é bug silencioso — este virou
            // "d.desde.slice is not a function" só porque o navegador reclamou.
            primeiroCommit: commits.length ? commits[commits.length - 1].data : null,
            ultimoCommit: commits.length ? commits[0].data : null
        };
    }

    // A escolha de repos fica em disco: implantação é uma sessão de trabalho que atravessa
    // reinícios, e refazer a seleção de 22 repos a cada abertura seria o próprio trabalho de novo.
    escolhidos() {
        try {
            return JSON.parse(readFileSync(ESCOLHIDOS, 'utf8')).projetos || [];
        } catch {
            return [];
        }
    }

    escolher(projetos) {
        writeFileSync(ESCOLHIDOS, `${JSON.stringify({ projetos, em: new Date().toISOString() }, null, 2)}\n`);
        return projetos;
    }

    // A PR de release, se já existe. `gh` é rede: chamado à parte, para a fila aparecer sem esperar.
    async prAberta(projeto, destino = 'main', origem = 'stage') {
        const bruto = await this.git(projeto, 'rev-parse', '--git-dir');
        if (bruto === null) {
            return null;
        }
        try {
            const { stdout } = await execFileAsync('gh',
                ['pr', 'list', '--head', origem, '--base', destino, '--state', 'open',
                    '--json', 'number,url,title,createdAt', '--limit', '1'],
                { cwd: join(WORKSPACE, projeto), encoding: 'utf8' });
            return JSON.parse(stdout || '[]')[0] || null;
        } catch {
            return null;
        }
    }
}

export default new Implantacao();

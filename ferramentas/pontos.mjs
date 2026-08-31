// Pontos de atenção da IA. Arquivo JSON e não banco: são no máximo 10 registros, e assim ficam
// legíveis, editáveis à mão, greppáveis e versionáveis — o `node:sqlite` do Node 22 é experimental
// e o projeto todo é sem dependência.
//
// uso: node qualidade/ferramentas/pontos.mjs listar [--json]
//      node qualidade/ferramentas/pontos.mjs add <id> <severidade> <titulo> <detalhe> [chamado] [projeto]
//      node qualidade/ferramentas/pontos.mjs remover <id>

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ARQUIVO = join(import.meta.dirname, '..', 'pontos-atencao.json');
const SEVERIDADES = ['atencao', 'aviso', 'nota'];

export class Pontos {
    ler() {
        if (!existsSync(ARQUIVO)) {
            return { teto: 10, pontos: [] };
        }
        try {
            const d = JSON.parse(readFileSync(ARQUIVO, 'utf8'));
            return { teto: d.teto ?? 10, pontos: Array.isArray(d.pontos) ? d.pontos : [] };
        } catch {
            return { teto: 10, pontos: [] };
        }
    }

    gravar(dados) {
        writeFileSync(ARQUIVO, `${JSON.stringify(dados, null, 2)}\n`);
    }

    // Os que valem para o que está na tela: do chamado, do projeto, ou gerais (campos nulos).
    para(chamado, projeto) {
        return this.ler().pontos.filter(p =>
            (!p.chamado || p.chamado === chamado) && (!p.projeto || p.projeto === projeto));
    }

    // Teto de 10: ponto novo só entra empurrando um velho, que é o freio contra a lista virar
    // despejo. Mas o descarte olha a SEVERIDADE antes da idade — descartar por idade pura deixava
    // uma `nota` de hoje empurrar fora um `atencao` da semana passada.
    add(ponto) {
        if (!SEVERIDADES.includes(ponto.severidade)) {
            throw new Error(`severidade deve ser uma de: ${SEVERIDADES.join(', ')}`);
        }
        const dados = this.ler();
        const semDuplicata = dados.pontos.filter(p => p.id !== ponto.id);
        semDuplicata.push({ criadoEm: new Date().toISOString().slice(0, 10), ...ponto });

        const descartados = [];
        while (semDuplicata.length > dados.teto) {
            const vitima = this._proximoADescartar(semDuplicata, ponto);
            if (!vitima) {
                // Só sobrou `atencao`: recusar é melhor que apagar em silêncio o que mais importa.
                throw new Error(`teto de ${dados.teto} atingido e todos os pontos são 'atencao'.\n`
                    + `Tire um à mão antes: node ferramentas/pontos.mjs remover <id>\n`
                    + `Atuais: ${semDuplicata.filter(p => p.id !== ponto.id).map(p => p.id).join(', ')}`);
            }
            descartados.push(vitima.id);
            semDuplicata.splice(semDuplicata.indexOf(vitima), 1);
        }
        dados.pontos = semDuplicata;
        this.gravar(dados);
        return { total: dados.pontos.length, descartados };
    }

    // `nota` sai antes de `aviso`, que sai antes de `atencao`. Dentro da mesma severidade, o mais
    // antigo. O ponto que está entrando nunca é a vítima.
    _proximoADescartar(pontos, entrando) {
        for (const severidade of ['nota', 'aviso']) {
            const candidatos = pontos.filter(p => p.severidade === severidade && p.id !== entrando.id);
            if (candidatos.length) {
                return candidatos.reduce((a, b) => ((a.criadoEm || '') <= (b.criadoEm || '') ? a : b));
            }
        }
        return null;
    }

    remover(id) {
        const dados = this.ler();
        const antes = dados.pontos.length;
        dados.pontos = dados.pontos.filter(p => p.id !== id);
        this.gravar(dados);
        return { removidos: antes - dados.pontos.length, total: dados.pontos.length };
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
        const dados = p.ler();
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

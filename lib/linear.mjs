// O chamado: título, status, link e os PRs que o Linear conhece.
//
// O servidor não fala com o Linear — quem fala é o agente, pela sessão dele. Então isto lê um CACHE
// que o agente grava (`ferramentas/linear.mjs gravar`). É dado com data, e a tela mostra a data:
// título velho é melhor que nenhum, mas só se estiver claro que é velho.
//
// Sem cache, o LINK ainda funciona: a URL do Linear é derivável do ID mais o slug do workspace.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));
const CACHE = join(RAIZ, 'linear-cache.json');
const CONFIG = join(RAIZ, 'linear.json');

export class Linear {
    _config() {
        try {
            return JSON.parse(readFileSync(CONFIG, 'utf8'));
        } catch {
            return {};
        }
    }

    _cache() {
        try {
            return JSON.parse(readFileSync(CACHE, 'utf8'));
        } catch {
            return {};
        }
    }

    // A URL canônica do Linear aceita só o ID: ele redireciona para o slug completo. Então o link
    // não depende do cache — só do slug do workspace.
    urlDe(chamado) {
        const { workspace } = this._config();
        return workspace ? `https://linear.app/${workspace}/issue/${chamado}` : null;
    }

    doChamado(chamado) {
        const guardado = this._cache()[chamado] || null;
        const url = guardado?.url || this.urlDe(chamado);
        if (!url) {
            return null;
        }
        return {
            chamado,
            url,
            titulo: guardado?.titulo || null,
            status: guardado?.status || null,
            atribuido: guardado?.atribuido || null,
            prs: guardado?.prs || [],
            atualizadoEm: guardado?.atualizadoEm || null,
            temCache: Boolean(guardado)
        };
    }

    gravar(chamado, dados) {
        const cache = this._cache();
        cache[chamado] = {
            titulo: dados.titulo ?? null,
            status: dados.status ?? null,
            atribuido: dados.atribuido ?? null,
            url: dados.url ?? this.urlDe(chamado),
            prs: (dados.prs || []).map(p => ({ titulo: p.titulo ?? p.title ?? null, url: p.url })),
            atualizadoEm: new Date().toISOString()
        };
        writeFileSync(CACHE, `${JSON.stringify(cache, null, 2)}\n`);
        return cache[chamado];
    }

    temConfig() {
        return existsSync(CONFIG);
    }
}

export default new Linear();

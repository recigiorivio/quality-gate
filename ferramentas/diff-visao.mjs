// Relatório HTML lado-a-lado (antes | depois) dos arquivos alterados, para revisar antes de abrir a PR.
// Usa `git diff -U100000` para receber o arquivo inteiro já marcado, em vez de reimplementar diff.
//
// uso: node qualidade/ferramentas/diff-visao.mjs <projeto> [base|-] [dir-de-saida]

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Diff } from '../lib/diff.mjs';

const RAIZ = join(import.meta.dirname, '..');

class DiffVisao {
    constructor(projeto, base, saida) {
        this.diff = new Diff(projeto);
        this.projeto = projeto;
        this.base = base;
        this.saida = saida;
    }

    escapar(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    renderLado(linhas) {
        return linhas.map(l =>
            `<div class="l ${l.tipo}"><span class="n">${l.n ?? ''}</span><code>${this.escapar(l.texto) || '&nbsp;'}</code></div>`
        ).join('');
    }

    gerar() {
        const base = this.diff.resolverBase(this.base);
        const branch = this.diff.branch();
        const arquivos = this.diff.listarArquivos(base);
        const blocos = arquivos.map(a => {
            const { antes, depois, adicionadas, removidas } = this.diff.montarColunas(base, a.caminho);
            const primeiraMudanca = antes.findIndex(l => l.tipo !== 'ctx');
            return `<details ${arquivos.length <= 6 ? 'open' : ''} data-ancora="${primeiraMudanca}">
  <summary><b>${this.escapar(a.caminho)}</b>
    <span class="badge ${a.estado}">${a.estado}</span>
    <span class="mais">+${adicionadas}</span><span class="menos">-${removidas}</span></summary>
  <div class="par">
    <div class="col"><h4>antes</h4>${this.renderLado(antes)}</div>
    <div class="col"><h4>depois</h4>${this.renderLado(depois)}</div>
  </div>
</details>`;
        }).join('\n');

        const html = `<!doctype html><meta charset="utf-8"><title>diff ${branch}</title>
<style>
:root{--bg:#fff;--fg:#1c1c1c;--linha:#e6e6e6;--add:#e6ffec;--rem:#ffebe9;--vazio:#fafafa;--num:#999}
@media(prefers-color-scheme:dark){:root{--bg:#161616;--fg:#e8e8e8;--linha:#2e2e2e;--add:#12341f;--rem:#3d1a1a;--vazio:#1b1b1b;--num:#666}}
*{box-sizing:border-box}body{margin:0;padding:20px;background:var(--bg);color:var(--fg);font:13px/1.5 system-ui,sans-serif}
h1{font-size:18px;margin:0 0 4px}.meta{color:var(--num);margin-bottom:20px;font-size:12px}
details{border:1px solid var(--linha);border-radius:6px;margin-bottom:12px;overflow:hidden}
summary{padding:9px 12px;cursor:pointer;background:var(--vazio);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
summary b{font-weight:600;font-family:ui-monospace,monospace;font-size:12px}
.badge{font-size:10px;padding:1px 6px;border-radius:10px;background:var(--linha)}
.mais{color:#1a7f37;font-weight:600}.menos{color:#cf222e;font-weight:600}
.par{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--linha);overflow-x:auto}
.col{background:var(--bg);min-width:0}
.col h4{margin:0;padding:5px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--num);border-bottom:1px solid var(--linha);position:sticky;top:0;background:var(--vazio)}
.l{display:flex;font-family:ui-monospace,monospace;font-size:12px;white-space:pre}
.l .n{flex:0 0 44px;text-align:right;padding-right:10px;color:var(--num);user-select:none}
.l code{white-space:pre;overflow:visible}
.add{background:var(--add)}.rem{background:var(--rem)}.vazio{background:var(--vazio)}
</style>
<h1>${this.escapar(this.projeto)} · ${this.escapar(branch)}</h1>
<div class="meta">${arquivos.length} arquivo(s) · base ${this.escapar(base.slice(0, 12))} · gerado ${new Date().toLocaleString('pt-BR')}</div>
${blocos || '<p>Nenhuma alteração contra a base.</p>'}
<script>
// Rola cada painel até a primeira mudança: arquivo grande abre no contexto útil, não no topo.
for (const d of document.querySelectorAll('details[data-ancora]')) {
  d.addEventListener('toggle', () => {
    if (!d.open) return;
    const alvo = d.querySelector('.l.rem, .l.add');
    if (alvo) alvo.scrollIntoView({ block: 'center' });
  }, { once: true });
  if (d.open) { const a = d.querySelector('.l.rem, .l.add'); if (a) a.scrollIntoView({ block: 'center' }); }
}
</script>`;

        const dir = this.saida || join(RAIZ, 'relatorios');
        mkdirSync(dir, { recursive: true });
        const destino = join(dir, `diff-${branch.replace(/\//g, '_')}.html`);
        writeFileSync(destino, html);
        return { destino, arquivos: arquivos.length, base };
    }
}

const [projeto, base, saida] = process.argv.slice(2);
if (!projeto) {
    console.error('uso: node diff-visao.mjs <projeto> [base] [dir-de-saida]');
    process.exit(1);
}
const r = new DiffVisao(projeto, base === '-' ? undefined : base, saida).gerar();
console.log(`${r.arquivos} arquivo(s) · base ${r.base.slice(0, 12)}\n${r.destino}`);

// O quadro do dev.fast Whiteboard virando HTML. Puro como o markdown.js (dado entra, HTML sai, sem
// DOM), para ser testável no `node --test`. Tempos do traço adaptados do Whiteboard (MIT).
import { mdParaHtml } from './markdown.js';
import { realcar, novoEstado, linguagemDe } from './realce.js';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// draw-motion.stylex.ts do Whiteboard: um nó por tique, o contorno, a linha e o rótulo depois dela.
export const TEMPOS = { tique: 120, traco: 420, linha: 450, atrasoRotulo: 300 };

const GEOMETRIA = { margem: 24, vaoLinha: 64, vaoNo: 64, linhaTexto: 16, larguraLetra: 7.1, raia: 28, raiaPasso: 14 };

// Link para código vira só o rótulo (o código está no diff ao lado), e negrito em volta de `código`
// passa a envolver só o texto fora dele: o markdown.js parte nas crases antes de casar o `**`.
const prepararMarkdown = md => String(md || '')
    .replace(/\[([^\]]+)\]\(review-source:[^)]*\)/g, '$1')
    .replace(/\*\*((?:[^*`]|`[^`]*`)+)\*\*/g, (todo, dentro) => (!dentro.includes('`') ? todo : dentro.split(/(`[^`]*`)/)
        .map((parte, i) => (i % 2 || !parte.trim() ? parte : parte.replace(/^(\s*)(.*?)(\s*)$/, '$1**$2**$3'))).join('')));

export function localDoTrecho(ancora) {
    const m = /^(?:head|base|diff)\/(.+?)(?:#L(\d+)(?:-[LR]?(\d+))?)?$/.exec(String(ancora || ''));
    if (!m) {
        return String(ancora || '');
    }
    const linhas = m[3] && m[3] !== m[2] ? `linhas ${m[2]}–${m[3]}` : m[2] ? `linha ${m[2]}` : '';
    return [m[1], linhas].filter(Boolean).join(' · ');
}

function quebrar(texto, max = 24) {
    const linhas = [];
    let atual = '';
    for (const palavra of String(texto || '').split(/\s+/).filter(Boolean)) {
        if (atual && (atual + ' ' + palavra).length > max) {
            linhas.push(atual);
            atual = palavra;
        } else {
            atual = atual ? `${atual} ${palavra}` : palavra;
        }
    }
    if (atual) {
        linhas.push(atual);
    }
    return linhas.length > 3 ? [...linhas.slice(0, 2), `${linhas.slice(2).join(' ').slice(0, max - 1)}…`] : linhas;
}

function medirNo(no) {
    const linhas = quebrar(no.label);
    const texto = Math.max(...linhas.map(l => l.length), 1) * GEOMETRIA.larguraLetra;
    const extra = (linhas.length - 1) * GEOMETRIA.linhaTexto;
    if (no.kind === 'decision') {
        return { linhas, w: Math.max(150, texto + 64), h: 58 + extra };
    }
    if (no.kind === 'terminal') {
        return { linhas, w: Math.max(120, texto + 40), h: 38 + extra };
    }
    return { linhas, w: Math.max(130, texto + 32), h: 44 + extra };
}

// Camadas pelo caminho mais longo; aresta que fecha ciclo não conta para a camada.
function camadas(nos, arestas) {
    const saidas = new Map(nos.map(n => [n.key, []]));
    arestas.forEach((e, i) => saidas.get(e.from).push({ ...e, i }));
    const volta = new Set();
    const visita = new Map();
    const visitar = chave => {
        visita.set(chave, 1);
        for (const e of saidas.get(chave)) {
            const v = visita.get(e.to) || 0;
            if (v === 1) {
                volta.add(e.i);
            } else if (v === 0) {
                visitar(e.to);
            }
        }
        visita.set(chave, 2);
    };
    nos.forEach(n => visita.get(n.key) || visitar(n.key));
    const entrada = new Map(nos.map(n => [n.key, 0]));
    arestas.forEach((e, i) => volta.has(i) || entrada.set(e.to, entrada.get(e.to) + 1));
    const camada = new Map(nos.map(n => [n.key, 0]));
    const fila = nos.filter(n => entrada.get(n.key) === 0).map(n => n.key);
    while (fila.length) {
        const chave = fila.shift();
        for (const e of saidas.get(chave)) {
            if (volta.has(e.i)) {
                continue;
            }
            camada.set(e.to, Math.max(camada.get(e.to), camada.get(chave) + 1));
            entrada.set(e.to, entrada.get(e.to) - 1);
            if (entrada.get(e.to) === 0) {
                fila.push(e.to);
            }
        }
    }
    return { camada, volta };
}

function retangulo(x, y, w, h, r) {
    const q = Math.min(r, h / 2, w / 2);
    return `M${x + q},${y}H${x + w - q}A${q},${q} 0 0 1 ${x + w},${y + q}V${y + h - q}`
        + `A${q},${q} 0 0 1 ${x + w - q},${y + h}H${x + q}A${q},${q} 0 0 1 ${x},${y + h - q}`
        + `V${y + q}A${q},${q} 0 0 1 ${x + q},${y}Z`;
}

function contorno(no) {
    const { cx, cy, w, h } = no;
    if (no.kind === 'decision') {
        return `M${cx},${cy - h / 2}L${cx + w / 2},${cy}L${cx},${cy + h / 2}L${cx - w / 2},${cy}Z`;
    }
    return retangulo(cx - w / 2, cy - h / 2, w, h, no.kind === 'terminal' ? h / 2 : 8);
}

const caminho = pts => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${Math.round(x)},${Math.round(y)}`).join('');

function rotaDaAresta(e, s, t, ctx) {
    const sobe = t.camada - s.camada;
    if (!ctx.volta && sobe === 1) {
        const y1 = s.cy + s.h / 2;
        const y2 = t.cy - t.h / 2;
        if (Math.abs(s.cx - t.cx) < 1) {
            return { pts: [[s.cx, y1], [t.cx, y2]], rotulo: { x: s.cx + 8, y: (y1 + y2) / 2 + 4, ancora: 'start' } };
        }
        const ym = (y1 + y2) / 2;
        return { pts: [[s.cx, y1], [s.cx, ym], [t.cx, ym], [t.cx, y2]], rotulo: { x: (s.cx + t.cx) / 2, y: ym - 6, ancora: 'middle' } };
    }
    if (!ctx.volta && sobe > 1) {
        const esquerda = t.cx < s.cx - 1;
        const meio = ctx.nos.filter(n => n.camada > s.camada && n.camada < t.camada);
        const borda = esquerda
            ? Math.min(s.cx - s.w / 2, ...meio.map(n => n.cx - n.w / 2))
            : Math.max(s.cx + s.w / 2, ...meio.map(n => n.cx + n.w / 2));
        const livre = esquerda ? t.cx < borda - 12 : t.cx > borda + 12;
        const raia = livre ? t.cx : borda + (esquerda ? -1 : 1) * (GEOMETRIA.raia + GEOMETRIA.raiaPasso * ctx.raias(esquerda));
        const x1 = s.cx + (esquerda ? -1 : 1) * s.w / 2;
        const topo = t.cy - t.h / 2;
        const pts = livre
            ? [[x1, s.cy], [raia, s.cy], [raia, topo]]
            : [[x1, s.cy], [raia, s.cy], [raia, topo - 18], [t.cx, topo - 18], [t.cx, topo]];
        return { pts, rotulo: { x: (x1 + raia) / 2, y: s.cy - 6, ancora: 'middle' } };
    }
    if (!ctx.volta && sobe === 0) {
        const lado = t.cx > s.cx ? 1 : -1;
        const pts = [[s.cx + lado * s.w / 2, s.cy], [t.cx - lado * t.w / 2, t.cy]];
        return { pts, rotulo: { x: (pts[0][0] + pts[1][0]) / 2, y: s.cy - 6, ancora: 'middle' } };
    }
    const raia = ctx.direita + GEOMETRIA.raia + GEOMETRIA.raiaPasso * ctx.raias(false);
    const pts = [[s.cx + s.w / 2, s.cy], [raia, s.cy], [raia, t.cy], [t.cx + t.w / 2, t.cy]];
    return { pts, rotulo: { x: raia + 6, y: (s.cy + t.cy) / 2, ancora: 'start' } };
}

export function desenharFluxo(d, { animar = false, indice = 0 } = {}) {
    const brutos = (d.nodes || []).filter(n => n && n.key);
    const chaves = new Set(brutos.map(n => n.key));
    const arestas = (d.edges || []).filter(e => chaves.has(e.from) && chaves.has(e.to));
    const { camada, volta } = camadas(brutos, arestas);
    const nos = brutos.map((n, ordem) => ({ ...n, ...medirNo(n), camada: camada.get(n.key), ordem }));
    const porChave = new Map(nos.map(n => [n.key, n]));
    const total = Math.max(0, ...nos.map(n => n.camada)) + 1;
    const linhas = Array.from({ length: total }, (_, c) => nos.filter(n => n.camada === c));
    // Uma passada de baricentro: cada nó perto da média dos que apontam para ele, contra cruzamentos.
    for (let c = 1; c < total; c++) {
        const media = n => {
            const pais = arestas.filter(e => e.to === n.key).map(e => porChave.get(e.from)).filter(p => p.camada < c);
            return pais.length ? pais.reduce((a, p) => a + p.posicao, 0) / pais.length : n.posicao;
        };
        linhas[c - 1].forEach((n, i) => { n.posicao = i - (linhas[c - 1].length - 1) / 2; });
        linhas[c].forEach((n, i) => { n.posicao = i - (linhas[c].length - 1) / 2; });
        linhas[c] = linhas[c].map((n, i) => ({ n, m: media(n), i })).sort((a, b) => a.m - b.m || a.i - b.i).map(x => x.n);
    }
    let y = GEOMETRIA.margem;
    for (const linha of linhas) {
        const altura = Math.max(0, ...linha.map(n => n.h));
        const largura = linha.reduce((a, n) => a + n.w, 0) + GEOMETRIA.vaoNo * Math.max(0, linha.length - 1);
        let x = -largura / 2;
        for (const n of linha) {
            n.cx = x + n.w / 2;
            n.cy = y + altura / 2;
            x += n.w + GEOMETRIA.vaoNo;
        }
        y += altura + GEOMETRIA.vaoLinha;
    }
    const contagem = { esquerda: 0, direita: 0 };
    const ctxBase = {
        nos,
        direita: Math.max(0, ...nos.map(n => n.cx + n.w / 2)),
        raias: esquerda => contagem[esquerda ? 'esquerda' : 'direita']++
    };
    const ordem = [...nos].sort((a, b) => a.camada - b.camada || a.ordem - b.ordem);
    ordem.forEach((n, i) => { n.atraso = i * TEMPOS.tique; });
    const rotas = arestas.map((e, i) => {
        const s = porChave.get(e.from);
        const t = porChave.get(e.to);
        const rota = rotaDaAresta(e, s, t, { ...ctxBase, volta: volta.has(i) });
        return { e, ...rota, atraso: Math.max(s.atraso, t.atraso) + TEMPOS.traco };
    });
    const xs = [...nos.flatMap(n => [n.cx - n.w / 2, n.cx + n.w / 2]), ...rotas.flatMap(r => r.pts.map(p => p[0]))];
    const ys = [...nos.flatMap(n => [n.cy - n.h / 2, n.cy + n.h / 2]), ...rotas.flatMap(r => r.pts.map(p => p[1]))];
    const minX = Math.min(...xs) - GEOMETRIA.margem - 20;
    const largura = Math.ceil(Math.max(...xs) - minX + GEOMETRIA.margem + 20);
    const altura = Math.ceil(Math.max(...ys) + GEOMETRIA.margem);
    const dx = x => Math.round(x - minX);
    nos.forEach(n => { n.cx = dx(n.cx); });
    rotas.forEach(r => { r.pts = r.pts.map(([x, py]) => [dx(x), py]); r.rotulo.x = dx(r.rotulo.x); });
    const seta = `q-seta-${indice}`;
    const atraso = ms => (animar ? ` style="--d:${Math.round(ms)}ms"` : '');
    const svgArestas = rotas.map(r => `<path class="q-aresta${r.e.style === 'dashed' ? ' q-tracejada' : ''}" pathLength="1" d="${caminho(r.pts)}" marker-end="url(#${seta})"${atraso(r.atraso)}/>`).join('');
    const svgRotulos = rotas.filter(r => r.e.label).map(r => `<text class="q-rotulo-aresta" x="${Math.round(r.rotulo.x)}" y="${Math.round(r.rotulo.y)}" text-anchor="${r.rotulo.ancora}"${atraso(r.atraso + TEMPOS.atrasoRotulo)}>${esc(r.e.label)}</text>`).join('');
    const svgNos = nos.map(n => {
        const topo = n.cy - ((n.linhas.length - 1) * GEOMETRIA.linhaTexto) / 2 + 4;
        const texto = n.linhas.map((l, i) => `<tspan x="${n.cx}" y="${Math.round(topo + i * GEOMETRIA.linhaTexto)}">${esc(l)}</tspan>`).join('');
        return `<g class="q-no q-${esc(n.kind || 'process')}"${atraso(n.atraso)}>${n.description ? `<title>${esc(n.description)}</title>` : ''}`
            + `<path class="q-no-forma" pathLength="1" d="${contorno(n)}"/><text class="q-no-texto" text-anchor="middle">${texto}</text></g>`;
    }).join('');
    return `<figure class="q-fluxo">${d.title ? `<figcaption class="q-fluxo-titulo">${esc(d.title)}</figcaption>` : ''}`
        + `<div class="q-fluxo-area"><svg viewBox="0 0 ${largura} ${altura}" style="max-width:${largura}px" role="img" aria-label="${esc(d.title || 'fluxo')}">`
        + `<defs><marker id="${seta}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" class="q-ponta"/></marker></defs>`
        + `${svgArestas}${svgNos}${svgRotulos}</svg></div>`
        + `${d.description ? `<p class="q-fluxo-desc">${esc(d.description)}</p>` : ''}</figure>`;
}

function profundidades(quadros) {
    const nivel = new Map();
    const de = f => (f.parentKey && nivel.has(f.parentKey) ? nivel.get(f.parentKey) + 1 : 0);
    quadros.forEach(f => nivel.set(f.key, de(f)));
    return nivel;
}

function pilha(quadros, outros, marca) {
    const nivel = profundidades(quadros);
    const chavesOutras = new Set(outros.map(f => f.key));
    return `<ol class="q-pilha">${quadros.map(f => {
        const classe = f.key && !chavesOutras.has(f.key) ? ` ${marca}` : '';
        const motivo = f.via?.reason ? `<small>${esc(f.via.reason)}</small>` : '';
        return `<li class="q-passo${classe}" style="--nivel:${nivel.get(f.key) || 0}"><span>${esc(f.label || localDoTrecho(f.source))}</span>${motivo}</li>`;
    }).join('')}</ol>`;
}

function antesDepois(c) {
    const base = c.base || [];
    const head = c.head || [];
    const coluna = (titulo, corpo) => `<div class="q-pilha-coluna"><p class="q-pilha-rotulo">${titulo}</p>${corpo}</div>`;
    return `<figure class="q-pilhas">${c.title ? `<figcaption class="q-fluxo-titulo">${esc(c.title)}</figcaption>` : ''}`
        + `<div class="q-pilhas-colunas">${coluna('antes', base.length ? pilha(base, head, 'q-saiu') : '<p class="q-fora">vazio</p>')}`
        + `${coluna('depois', head.length ? pilha(head, base, 'q-novo') : '<p class="q-fora">vazio</p>')}</div></figure>`;
}

function sequencia(c) {
    const ator = k => esc(c.actors?.[k] || k);
    const passos = (c.steps || []).map(p => `<li class="q-seq-passo q-seq-${esc(p.style || 'call')}"><span class="q-ator">${ator(p.from)}</span>`
        + `<span class="q-seq-seta">${p.style === 'return' ? '⇠' : '→'}</span><span class="q-ator">${ator(p.to)}</span>`
        + `<span class="q-seq-rotulo">${esc(p.label)}</span></li>`).join('');
    return `<figure class="q-sequencia">${c.title ? `<figcaption class="q-fluxo-titulo">${esc(c.title)}</figcaption>` : ''}<ol>${passos}</ol></figure>`;
}

function lenteDeDados(c) {
    const lojas = Object.values(c.stores || {}).map(s => `<li><b>${esc(s.label)}</b> ${Object.values(s.collections || {}).map(col => `<code>${esc(col.label)}</code>`).join(' ')}</li>`).join('');
    const usos = (c.useCases || []).map(u => `<li><b>${esc(u.label)}</b>${u.summary ? ` · ${esc(u.summary)}` : ''}<ul>${(u.operations || [])
        .map(o => `<li>${esc(o.kind === 'write' ? 'escreve' : 'lê')} ${esc(c.actors?.[o.actor] || o.actor)} → <code>${esc(o.collection)}</code> · ${esc(o.label)}</li>`).join('')}</ul></li>`).join('');
    return `<figure class="q-dados">${c.title ? `<figcaption class="q-fluxo-titulo">${esc(c.title)}</figcaption>` : ''}<ul>${lojas}</ul><ul>${usos}</ul></figure>`;
}

const APELIDOS = { javascript: 'js', typescript: 'ts', python: 'py', shell: 'sh', bash: 'sh' };
const ICONE_COPIAR = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11"/></svg>';
const selo = caminho => (String(caminho).split('.').pop() || '').slice(0, 4).toUpperCase();

function linhasNumeradas(linhas, inicio, ling) {
    const estado = novoEstado();
    return `<table class="q-linhas"><tbody>${linhas.map((l, i) => `<tr><td class="q-num">${inicio + i}</td>`
        + `<td class="q-src">${l ? realcar(l, ling, estado) : '&nbsp;'}</td></tr>`).join('')}</tbody></table>`;
}

// O código vem do servidor (`trecho`, lido no commit do quadro); sem ele, fica a referência e o motivo.
function trechoDeCodigo(c) {
    const caminho = (/^(?:head|base|diff)\/(.+?)(?:#|$)/.exec(c.source || '') || [])[1] || String(c.source || '');
    const t = c.trecho;
    const legenda = c.caption ? `<figcaption class="q-peek-legenda">${esc(c.caption)}</figcaption>` : '';
    const cabeca = meta => `<span class="q-selo">${esc(selo(caminho))}</span><code class="q-peek-arquivo">${esc(caminho)}</code>`
        + `<span class="q-peek-meta">${esc(meta)}</span>`;
    if (!t?.linhas) {
        const onde = localDoTrecho(c.source).split(' · ').slice(1).join(' · ');
        return `<figure class="q-peek-figura"><div class="q-peek"><div class="q-peek-cabeca">${cabeca(onde)}</div>`
            + `${t?.erro ? `<p class="q-peek-erro">${esc(t.erro)}</p>` : ''}</div>${legenda}</figure>`;
    }
    const intervalo = t.fim > t.inicio ? `linhas ${t.inicio}–${t.fim}` : `linha ${t.inicio}`;
    return `<figure class="q-peek-figura"><details class="q-peek" open><summary class="q-peek-cabeca">`
        + `<span class="q-chev" aria-hidden="true"></span>${cabeca(`${t.repo} · ${intervalo}`)}</summary>`
        + `<div class="q-peek-corpo">${linhasNumeradas(t.linhas, t.inicio, linguagemDe(caminho))}</div></details>${legenda}</figure>`;
}

function blocoDeCodigo(c) {
    const linhas = String(c.text ?? '').replace(/\n$/, '').split('\n');
    const nome = String(c.language || '').toLowerCase();
    const ling = nome && !['text', 'plain', 'plaintext'].includes(nome) ? linguagemDe(`x.${APELIDOS[nome] || nome}`) : null;
    return `<figure class="q-codigo"><div class="q-codigo-cabeca"><span class="q-selo">${esc(ling ? nome.toUpperCase() : 'PLAIN')}</span>`
        + `<span class="q-codigo-titulo">${esc(c.caption || '')}</span>`
        + `<span class="q-codigo-meta">${linhas.length} linha${linhas.length === 1 ? '' : 's'}</span>`
        + `<button type="button" class="q-copiar" onclick="copiarDoQuadro(this)" title="copiar" aria-label="copiar">${ICONE_COPIAR}</button></div>`
        + `<div class="q-codigo-corpo">${linhasNumeradas(linhas, 1, ling)}</div></figure>`;
}

// A imagem vem da cópia que `subirImagem` guardou; sem cópia, o erro de carga volta ao aviso de antes.
function imagem(c) {
    const aviso = "this.replaceWith(Object.assign(document.createElement('p'),{className:'q-fora',textContent:'image: só no app do Whiteboard.'}))";
    return `<figure class="q-imagem"><img src="/api/whiteboard-imagem?id=${encodeURIComponent(c.assetId || '')}" alt="${esc(c.alt || '')}"`
        + ` loading="lazy" onerror="${aviso}">${c.caption ? `<figcaption>${esc(c.caption)}</figcaption>` : ''}</figure>`;
}

function bloco(c, ctx) {
    switch (c?.type) {
    case 'section': {
        const filhos = (c.children || []).map(f => bloco(f, ctx)).join('');
        return c.defaultCollapsed
            ? `<details class="q-secao"><summary class="q-secao-titulo">${esc(c.title)}</summary>${filhos}</details>`
            : `<section class="q-secao"><h3 class="q-secao-titulo">${esc(c.title)}</h3>${filhos}</section>`;
    }
    case 'markdown':
        return `<div class="q-md">${mdParaHtml(prepararMarkdown(c.markdown), ctx.linkDoId)}</div>`;
    case 'callout':
        return `<aside class="q-aviso q-tom-${esc(c.tone || 'info')}">${c.title ? `<p class="q-aviso-titulo">${esc(c.title)}</p>` : ''}`
            + `${(c.children || []).map(f => bloco(f, ctx)).join('')}</aside>`;
    case 'code_peek':
        return trechoDeCodigo(c);
    case 'code':
        return blocoDeCodigo(c);
    case 'divider':
        return '<hr class="q-divisor">';
    case 'flow_diagram':
        return desenharFluxo(c, { animar: ctx.animar, indice: ctx.fluxos++ });
    case 'call_stack_diff':
        return antesDepois(c);
    case 'sequence':
        return sequencia(c);
    case 'database_lens':
        return lenteDeDados(c);
    case 'image':
        return imagem(c);
    default:
        return `<p class="q-fora">${esc(c?.type || 'bloco')}: só no app do Whiteboard.</p>`;
    }
}

export function quadroParaHtml(documento, { animar = false, linkDoId } = {}) {
    const ctx = { animar, linkDoId, fluxos: 0 };
    const blocos = (Array.isArray(documento) ? documento : []).map(c => bloco(c, ctx)).join('');
    return `<article class="quadro${animar ? ' q-anim' : ''}">${blocos}</article>`;
}

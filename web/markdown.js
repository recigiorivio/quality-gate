// O markdown que o agente escreve, virando HTML. Renderizador próprio em vez de biblioteca porque o
// projeto não tem dependência — e o que sai do agente é sempre o mesmo subconjunto: títulos, listas,
// tabelas, código, negrito, citação.
//
// Módulo separado do app.js por um motivo só: aqui dentro é tudo PURO (texto entra, HTML sai, sem
// DOM), e isso o deixa testável direto no `node --test`. A ordem entre escapar e casar marcação é
// onde ele erra em silêncio: a citação `>` já tinha virado `&gt;` antes da regra que a procurava, e
// nenhum blockquote saía — a tela não acusava nada, só mostrava a linha como parágrafo.

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ehTabela = l => /^\s*\|.*\|\s*$/.test(l);
const separadorDeTabela = l => /^\s*\|[\s:|-]+\|\s*$/.test(l);

// `linkDoId` recebe um ID de chamado (UND-1638) e devolve a URL dele, ou nada. Vem de fora porque a
// base do Linear é configuração da tela, e este módulo não conhece configuração nenhuma.
export function mdParaHtml(texto, linkDoId = () => null) {
    const saida = [];
    let lista = null;
    let codigo = false;
    let paragrafo = [];
    let tabela = [];

    // Trecho entre crases é literal: partir por eles e transformar só o que está FORA é o que
    // impede um `**` dentro de um comando virar negrito, e um ID dentro de um caminho virar link.
    const inline = s => s.split(/(`[^`]+`)/)
        .map((parte, i) => (i % 2 ? `<code>${parte.slice(1, -1)}</code>` : foraDeCodigo(parte)))
        .join('');

    const foraDeCodigo = s => s
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>')
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        // O ID do chamado vira link pelo mesmo motivo que na trilha: é a única coisa no texto que
        // leva para fora, e copiar e colar à mão é o atrito que faz ninguém conferir.
        .replace(/\b[A-Z]{2,5}-\d+\b/g, id => {
            const url = linkDoId(id);
            return url ? `<a href="${url}" target="_blank" rel="noopener">${id}</a>` : id;
        });

    const fecharP = () => {
        if (paragrafo.length) {
            saida.push(`<p>${paragrafo.join('<br>')}</p>`);
            paragrafo = [];
        }
    };
    const fecharLista = () => {
        if (lista) {
            saida.push(`</${lista}>`);
            lista = null;
        }
    };
    const fecharTabela = () => {
        if (!tabela.length) {
            return;
        }
        const comCabeca = tabela.length > 1 && separadorDeTabela(tabela[1]);
        const celulas = tabela.filter(l => !separadorDeTabela(l))
            .map(l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim())));
        const cabeca = comCabeca
            ? `<thead><tr>${celulas[0].map(c => `<th>${c}</th>`).join('')}</tr></thead>` : '';
        const corpo = celulas.slice(comCabeca ? 1 : 0)
            .map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
        // A tabela rola dentro da própria caixa: a modal tem largura fixa e uma coluna larga não
        // pode empurrar o texto todo para o lado.
        saida.push(`<div class="md-rolo"><table class="md-tab">${cabeca}<tbody>${corpo}</tbody></table></div>`);
        tabela = [];
    };
    const fechar = () => {
        fecharP();
        fecharLista();
        fecharTabela();
    };
    const abrirLista = tipo => {
        if (lista !== tipo) {
            fecharP();
            fecharLista();
            saida.push(`<${tipo}>`);
            lista = tipo;
        }
    };

    // Escapa ANTES de qualquer regra: assim nada do texto do agente vira tag, e as únicas tags do
    // resultado são as que estas linhas põem. É por isso que a citação procura `&gt;` e não `>`.
    for (const bruta of esc(texto || '').split('\n')) {
        const l = bruta.replace(/\s+$/, '');
        if (/^\s*```/.test(l)) {
            fechar();
            saida.push(codigo ? '</code></pre>' : '<pre class="md-cod"><code>');
            codigo = !codigo;
            continue;
        }
        if (codigo) {
            saida.push(l);
            continue;
        }
        if (ehTabela(l)) {
            fecharP();
            fecharLista();
            tabela.push(l);
            continue;
        }
        fecharTabela();
        const titulo = l.match(/^(#{1,6})\s+(.*)$/);
        const ponto = l.match(/^\s*[-*+]\s+(.*)$/);
        const numero = l.match(/^\s*\d+[.)]\s+(.*)$/);
        if (!l.trim()) {
            fechar();
        } else if (titulo) {
            // Desce dois níveis: o `#` do agente não pode competir com o título da modal.
            const nivel = Math.min(6, titulo[1].length + 2);
            fechar();
            saida.push(`<h${nivel}>${inline(titulo[2])}</h${nivel}>`);
        } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(l.trim())) {
            fechar();
            saida.push('<hr>');
        } else if (ponto) {
            abrirLista('ul');
            saida.push(`<li>${inline(ponto[1])}</li>`);
        } else if (numero) {
            abrirLista('ol');
            saida.push(`<li>${inline(numero[1])}</li>`);
        } else if (/^\s*&gt;\s?/.test(l)) {
            fechar();
            saida.push(`<blockquote>${inline(l.replace(/^\s*&gt;\s?/, ''))}</blockquote>`);
        } else {
            fecharLista();
            paragrafo.push(inline(l));
        }
    }
    fechar();
    // Cerca de código aberta e nunca fechada: sem isto o `<pre>` vaza para o resto da modal.
    if (codigo) {
        saida.push('</code></pre>');
    }
    return saida.join('\n');
}

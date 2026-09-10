// Casca HTML. CSS e JS são arquivos próprios — ver web/app.js.
//
// Três zonas, da esquerda para a direita:
//  - a barra só NAVEGA: uma linha por chamado, engrenagem no pé
//  - o conteúdo, no meio: veredito, abas, cartões e o diff em largura cheia
//  - a trilha, à direita: as branches e o Linear — recolhível, porque o diff é a coisa mais larga
//    do app e há momentos em que ele precisa de todo o espaço
//
// Antes a barra fazia os três trabalhos ao mesmo tempo e chegava a 89 linhas em 340px.

// A versão dos assets é o mtime deles. Sem isso o navegador segura o app.js entre reinícios do
// servidor: a tela ficou mostrando 1 arquivo e `base origin/stage` porque o cliente velho não
// mandava o `chamado`, e o servidor já respondia a comparação da PR. Uma hora de confusão.
export function pagina(esqueleto, versao = '', token = '', local = true, linear = '') {
    return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Qualidade — conferência por chamado</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=${versao}">
<link rel="stylesheet" href="/estilo.css?v=${versao}">
</head><body>
<aside>
  <h1 id="titulo-barra"><span class="mago" aria-hidden="true">🧙</span>
    <span><span class="nome">Magias do Mago</span><span class="sub">conferência por chamado</span></span></h1>
  <div id="painel-chamados">
    <div id="lista" aria-busy="true">
      <div class="carregando" style="min-height:78px"><span class="giro"></span></div>
    </div>
    <div id="ocultos"></div>
  </div>
  <div id="painel-config" hidden></div>
  <div id="painel-implantacao" hidden></div>
  <div id="acao-barra">
    <button id="btn-implantacao" onclick="trocarVisao(visao === 'implantacao' ? 'chamados' : 'implantacao')"
            title="Implantação — o que está em stage e ainda não foi para main">
      <span class="foguete" aria-hidden="true">🚀</span><span>Implantação</span>
      <span class="conta-impl" id="conta-impl"></span>
    </button>
  </div>
  <footer id="pe-barra">
    <button id="btn-config" onclick="trocarVisao(visao === 'config' ? 'chamados' : 'config')"
            title="Configurações — as rotinas que eu sigo">
      <span class="engrenagem" aria-hidden="true">⚙</span><span>Configurações</span>
    </button>
  </footer>
</aside>
<div id="carga" aria-hidden="true"><div class="carga-fio"></div></div>
<main>
  <div id="cabecalho" hidden></div>
  <div id="conteudo" class="aviso">Escolha um chamado à esquerda.</div>
  <!-- Cobre o conteúdo só na PRIMEIRA carga, quando não há nada para mostrar. Já vem no HTML para
       não depender do JS, e sai no primeiro conteúdo que chega. Nas cargas seguintes quem avisa é o
       fio do topo: cobrir a tela inteira por um cache hit de 100 ms seria pisca, não informação. -->
  <div id="carregando-tela"><span class="giro giro-grande"></span><span>lendo os repos…</span></div>
</main>
<div id="trilha" hidden>
  <button id="trilha-toggle" onclick="alternarMenu()" title="recolher/expandir">›</button>
  <div id="trilha-corpo"></div>
</div>
<script>window.ESQUELETO = ${JSON.stringify(esqueleto)};</script>
<script>window.VERSAO = '${versao}'; window.LINEAR = '${linear}'; window.TOKEN = '${token}'; window.LOCAL = ${local};</script>
<script type="module" src="/app.js?v=${versao}"></script>
</body></html>`;
}

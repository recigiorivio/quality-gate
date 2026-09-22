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
  <nav id="abas" role="tablist" aria-label="visões da barra">
    <button class="aba ativa" id="aba-chamados" role="tab" onclick="trocarVisao('chamados')">
      <span class="ab-i" aria-hidden="true">🧙</span><span class="ab-n">Chamados</span>
      <span class="ab-c" id="conta-chamados"></span>
    </button>
    <button class="aba" id="aba-implantacao" role="tab" onclick="trocarVisao('implantacao')">
      <span class="ab-i" aria-hidden="true">🚀</span><span class="ab-n">Implantação</span>
      <span class="ab-c" id="conta-impl"></span>
    </button>
    <button class="aba" id="aba-config" role="tab" onclick="trocarVisao('config')">
      <span class="ab-i" aria-hidden="true">⚙</span><span class="ab-n">Configurações</span>
    </button>
  </nav>
  <div class="painel" id="painel-chamados">
    <div id="lista" aria-busy="true">
      <div class="carregando" style="min-height:78px"><span class="giro"></span></div>
    </div>
    <div id="ocultos"></div>
  </div>
  <div class="painel" id="visao-implantacao" hidden>
    <div class="pn-acoes">
      <span class="sf-recarregar" id="btn-atualizar-impl" role="button" tabindex="0"
            onclick="atualizarImplantacao(event)" onkeydown="if(event.key==='Enter'){atualizarImplantacao(event)}"
            title="buscar origin/main e origin/stage de novo — a fila é lida desses dois refs">⟳</span>
    </div>
    <div id="builds"></div>
    <div id="painel-implantacao"></div>
  </div>
  <div class="painel" id="painel-config" hidden></div>
  <!-- O pé é o que NÃO é visão: estado da máquina, que vale nas três. Estava dentro de Chamados e
       sumia nas outras duas — justamente quando saber que há agente rodando mais importa. -->
  <footer id="pe-barra">
    <div id="sessoes"></div>
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

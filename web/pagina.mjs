// Casca HTML. CSS e JS são arquivos próprios — ver web/app.js.

export function pagina(esqueleto) {
    return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Qualidade — conferência por chamado</title>
<link rel="stylesheet" href="/estilo.css">
</head><body>
<aside>
  <nav id="nav">
    <button class="ativa" data-v="chamados" onclick="trocarVisao('chamados')">Chamados</button>
    <button data-v="config" onclick="trocarVisao('config')">Configurações</button>
  </nav>
  <div id="painel-chamados">
    <div id="lista">carregando…</div>
    <div id="ocultos"></div>
  </div>
  <div id="painel-config" hidden></div>
</aside>
<main><div id="conteudo" class="aviso">Escolha um repo à esquerda.</div></main>
<script>window.ESQUELETO = ${JSON.stringify(esqueleto)};</script>
<script type="module" src="/app.js"></script>
</body></html>`;
}

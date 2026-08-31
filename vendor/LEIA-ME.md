# vendor/

`acorn.mjs` — parser JS (ECMAScript), copiado de `crohc-server/node_modules/acorn/dist/acorn.mjs`
na versão **8.14.1**. Arquivo único, sem dependências, licença MIT.

**Por que copiado e não importado do node_modules de outro projeto:** um `npm ci` no `crohc-server`
apagaria o caminho e quebraria esta tela. Projeto independente não empresta node_modules.

**Por que AST e não regex:** duas regras desta ferramenta já acusaram o jeito CERTO por olharem uma
linha um problema que vive em várias — comentário acima de `class` e filtro Mongo multilinha. Com
AST, "esse `find` tem filtro vazio?" deixa de ser heurística e vira `arg.properties.length === 0`.
Custo medido: 6 ms para 179 linhas.

Para atualizar: copiar de novo de um `node_modules/acorn/dist/acorn.mjs` e anotar a versão aqui.

A licença do acorn (MIT) está em `acorn-LICENSE`.

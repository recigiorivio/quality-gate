// Sobe uma imagem (mockup, print) para um quadro do Whiteboard e guarda a cópia que a tela serve: o
// Whiteboard não devolve imagem pela API, então a que sobe direto pelo `session_upload` fica só no app.
// Imprime o id de cada arquivo, para o bloco `{type: 'image', assetId: <id>, alt, caption}`.
//
// uso: node ferramentas/whiteboard-imagem.mjs <sessionId do quadro> <arquivo.png> [mais arquivos...]

import { subirImagem } from '../lib/whiteboard.mjs';

const [sessao, ...arquivos] = process.argv.slice(2);
if (!sessao || !arquivos.length) {
    console.error('uso: node ferramentas/whiteboard-imagem.mjs <sessionId do quadro> <arquivo.png> [mais arquivos...]');
    process.exit(1);
}

for (const arquivo of arquivos) {
    console.log(`${await subirImagem({ sessao, arquivo })}  ${arquivo}`);
}

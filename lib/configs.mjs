// Os arquivos que a instalação planta no workspace, e que a aba Configurações edita.
//
// Allowlist por chave, nunca caminho vindo do cliente: é o que impede escrever fora daqui.
//
// Mora aqui, e não no `server.mjs`, porque a instalação e a desinstalação precisam da mesma lista:
// importar o servidor para ler um mapa já sobe o servidor.
//
// O prefixo `quality-` no nome não é enfeite: sem ele o destino colide com a rotina que o time já
// tem, e a instalação "termina ok" tendo pulado os três arquivos. Nome próprio troca a colisão por
// convivência — e dá ao desinstalador um prefixo único para varrer.
export const CONFIGS = {
    inicio: {
        caminho: '.claude/commands/quality-inicio-trabalho.md',
        rotulo: 'Rotina de início',
        resumo: 'O que conferir antes de planejar ou escrever código'
    },
    fim: {
        caminho: '.claude/commands/quality-fim-trabalho.md',
        rotulo: 'Rotina de fim',
        resumo: 'O que corrigir e o que conferir antes de entregar'
    },
    regras: {
        caminho: '.claude/docs/quality-qualidade-de-codigo.md',
        rotulo: 'Regras de código',
        resumo: 'Comentários, estrutura, testes — as regras que as checagens cobram'
    },
    subir: {
        caminho: '.claude/commands/quality-subir-tela.md',
        rotulo: 'Subir a tela',
        resumo: 'Como pôr a tela no ar — ela não sobe sozinha sem o LaunchAgent'
    }
};

// O arquivo que o hook injeta no fim de trabalho. O gate lê por nome, então renomear o padrão sem
// mexer aqui desligaria o gatilho em silêncio.
export const ROTINA_FIM = CONFIGS.fim.caminho;

// Os padrões trazem os comandos com `{{CLONE}}` e `{{TELA}}` no lugar do caminho e da URL, e a
// INSTALAÇÃO reescreve na hora de plantar.
//
// Por que não deixar o caminho fixo: o clone pode ter qualquer nome, e um comando com a pasta errada
// dentro da rotina é pior que nenhum comando — o agente tenta, falha, e a rotina perde autoridade.
// Por que não deixar `<na pasta do projeto>` para a pessoa preencher: placeholder em comando é
// instrução que ninguém executa; o que se quer é poder copiar e rodar.
export function comCaminhos(texto, { clone, porta = 4100 } = {}) {
    return String(texto)
        .replaceAll('{{CLONE}}', clone || 'quality-gate')
        .replaceAll('{{TELA}}', `http://localhost:${porta}`);
}

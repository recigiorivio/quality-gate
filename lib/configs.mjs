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
    }
};

// O arquivo que o hook injeta no fim de trabalho. O gate lê por nome, então renomear o padrão sem
// mexer aqui desligaria o gatilho em silêncio.
export const ROTINA_FIM = CONFIGS.fim.caminho;

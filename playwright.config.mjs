// Testes de TELA. Os de servidor e de biblioteca continuam em `teste/`, no `node:test` — este
// runner existe só para o que precisa de navegador de verdade.
//
// Nenhum `webServer` aqui de propósito: quem sobe o servidor é a fixture em `teste-tela/apoio.mjs`,
// uma vez por caso, em porta livre e com estado temporário. Um `webServer` compartilhado seria um
// servidor só para todos os casos — e um caso que escreve estragaria o dado do vizinho, que é uma
// versão menor do erro que me fez apagar a escolha de repos do usuário quatro vezes.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    // Antes de tudo, colher servidor de teste órfão de rodada interrompida: dois deles vivos já
    // puseram a carga da máquina em 5,8 e derrubaram por tempo casos que passavam sozinhos.
    globalSetup: './teste-tela/colheita.mjs',
    testDir: './teste-tela',
    testMatch: '**/*.spec.mjs',
    // Sem retry: `click()` do Playwright já reencontra elemento destacado por conta própria, e foi
    // essa resiliência que transformou um clique num nó que sumia em quatro remoções em cascata.
    // Repetir o caso inteiro por cima disso esconderia justamente a instabilidade que interessa ver.
    retries: 0,
    // Um worker. Cada caso sobe um servidor que varre os 51 repos do workspace com git; três em
    // paralelo disputam disco e CPU, e o que se mede vira o tempo da máquina, não o da tela.
    // Medido: com 3 workers, dois casos falharam por tempo esgotado esperando a tabela; com 1,
    // os mesmos casos passam. Paralelismo que precisa de teto de tempo maior não é paralelismo.
    workers: 1,
    timeout: 60000,
    expect: { timeout: 15000 },
    reporter: [['list']],
    use: {
        ...devices['Desktop Chrome'],
        channel: undefined,
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure'
    }
});

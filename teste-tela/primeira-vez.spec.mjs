// O portão da primeira abertura.
//
// Ele existe porque a tela lendo a pasta errada abre VAZIA, e vazia é indistinguível de "não há
// trabalho aberto" — o modo de falha silencioso que este projeto inteiro persegue. Sendo portão, o
// risco que ele traz é o oposto: aparecer quando não devia e travar a ferramenta para todo mundo.
// Estes casos cobram os dois lados.
import { test, expect } from './apoio.mjs';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.describe('primeira abertura', () => {
    test.use({ primeiraVez: true });

    test('o portão abre, sugere a raiz detectada e conta os repos dela', async ({ tela }) => {
        const { pagina, base } = tela;
        await pagina.goto(base, { waitUntil: 'domcontentloaded' });
        await expect(pagina.locator('#modal-boas-vindas')).toBeVisible();
        await expect(pagina.locator('#bv-raiz')).not.toHaveValue('');
        // Conta, não só "achei a pasta": o número é o que diz à pessoa que a raiz é a certa antes
        // de ela clicar, e foi por não ter esse eco que a tela vazia virava mistério.
        await expect(pagina.locator('#bv-repos')).toHaveText(/\d+ repo\(s\) git aqui/);
    });

    test('Esc não fecha: sair sem escolher deixaria a tela lendo a pasta errada', async ({ tela }) => {
        const { pagina, base } = tela;
        await pagina.goto(base, { waitUntil: 'domcontentloaded' });
        await expect(pagina.locator('#modal-boas-vindas')).toBeVisible();
        await pagina.keyboard.press('Escape');
        await expect(pagina.locator('#modal-boas-vindas')).toBeVisible();
    });

    // Três respostas, não duas: pasta ilegível é erro de caminho e zero repos é caminho certo num
    // lugar vazio. Juntar as duas manda a pessoa procurar o problema no lugar errado.
    test('caminho ilegível e pasta sem repo dizem coisas diferentes', async ({ tela }) => {
        const { pagina, base } = tela;
        const vazia = mkdtempSync(join(tmpdir(), 'sem-repo-'));
        await pagina.goto(base, { waitUntil: 'domcontentloaded' });
        await expect(pagina.locator('#modal-boas-vindas')).toBeVisible();

        await pagina.fill('#bv-raiz', '/isto/nao/existe/mesmo');
        await expect(pagina.locator('#bv-repos')).toHaveText(/não consigo ler/);

        await pagina.fill('#bv-raiz', vazia);
        await expect(pagina.locator('#bv-repos')).toHaveText(/nenhum repo git/);
    });

    test('planta as rotinas escolhidas, e o portão não volta', async ({ tela }) => {
        const { pagina, base } = tela;
        const workspace = mkdtempSync(join(tmpdir(), 'ws-'));
        mkdirSync(join(workspace, 'repo-a', '.git'), { recursive: true });
        await pagina.goto(base, { waitUntil: 'domcontentloaded' });
        await pagina.fill('#bv-raiz', workspace);
        await expect(pagina.locator('#bv-repos')).toHaveText(/1 repo\(s\)/);
        await pagina.click('.bv-ok');

        // Raiz trocada não fecha o portão: `WORKSPACE` é resolvido na carga dos módulos, e fechar
        // aqui deixaria metade da tela lendo a pasta antiga sem ninguém saber.
        await expect(pagina.locator('#modal-boas-vindas')).toContainText(/npm start/);
        for (const rel of ['.claude/commands/inicio-trabalho.md', '.claude/commands/final-trabalho.md',
            '.claude/docs/qualidade-de-codigo.md']) {
            expect(existsSync(join(workspace, rel)), `${rel} tinha que ter sido plantado`).toBe(true);
        }

        await pagina.reload({ waitUntil: 'domcontentloaded' });
        await pagina.waitForTimeout(1200);
        await expect(pagina.locator('#modal-boas-vindas')).toHaveCount(0);
    });
});

test('sem ser a primeira vez, o portão não aparece', async ({ tela }) => {
    const { pagina, base } = tela;
    await pagina.goto(base, { waitUntil: 'domcontentloaded' });
    await pagina.waitForTimeout(1200);
    await expect(pagina.locator('#modal-boas-vindas')).toHaveCount(0);
});

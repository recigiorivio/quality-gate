// O portão da primeira abertura.
//
// Ele existe porque a tela lendo a pasta errada abre VAZIA, e vazia é indistinguível de "não há
// trabalho aberto" — o modo de falha silencioso que este projeto inteiro persegue. Sendo portão, o
// risco que ele traz é o oposto: aparecer quando não devia e travar a ferramenta para todo mundo.
// Estes casos cobram os dois lados.
import { test, expect } from './apoio.mjs';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
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
        for (const rel of ['.claude/commands/quality-inicio-trabalho.md',
            '.claude/commands/quality-fim-trabalho.md',
            '.claude/docs/quality-qualidade-de-codigo.md']) {
            expect(existsSync(join(workspace, rel)), `${rel} tinha que ter sido plantado`).toBe(true);
        }

        await pagina.reload({ waitUntil: 'domcontentloaded' });
        await pagina.waitForTimeout(1200);
        await expect(pagina.locator('#modal-boas-vindas')).toHaveCount(0);
    });

    // O .md apontado tem que CHEGAR no destino. O padrão genérico é ponto de partida, e instalar o
    // genérico calado depois de a pessoa escolher o dela é a falha que não dá erro nenhum.
    test('o .md escolhido é plantado no lugar do padrão', async ({ tela }) => {
        const { pagina, base } = tela;
        const workspace = mkdtempSync(join(tmpdir(), 'ws-pick-'));
        mkdirSync(join(workspace, 'repo-a', '.git'), { recursive: true });
        const meu = join(mkdtempSync(join(tmpdir(), 'meus-md-')), 'a-minha-rotina.md');
        writeFileSync(meu, '# A minha rotina de fim\n\nnada de genérico aqui.\n');

        await pagina.goto(base, { waitUntil: 'domcontentloaded' });
        await pagina.fill('#bv-raiz', workspace);
        await expect(pagina.locator('#bv-repos')).toHaveText(/1 repo\(s\)/);
        await pagina.setInputFiles('input[data-pick="fim"]', meu);
        await expect(pagina.locator('#bv-itens')).toContainText('a-minha-rotina.md');
        await pagina.click('.bv-ok');
        await expect(pagina.locator('#modal-boas-vindas')).toContainText(/npm start/);

        const plantado = join(workspace, '.claude/commands/quality-fim-trabalho.md');
        expect(readFileSync(plantado, 'utf8')).toContain('nada de genérico aqui');
        // As outras duas não foram escolhidas, e por isso seguem vindo do padrão.
        expect(readFileSync(join(workspace, '.claude/commands/quality-inicio-trabalho.md'), 'utf8'))
            .not.toContain('nada de genérico aqui');
    });

    // Escolher e desistir tem que voltar ao padrão: "usar o padrão" que não limpa a escolha plantaria
    // o arquivo que a pessoa acabou de rejeitar.
    test('desistir da escolha volta para o padrão', async ({ tela }) => {
        const { pagina, base } = tela;
        const meu = join(mkdtempSync(join(tmpdir(), 'meus-md-')), 'descartada.md');
        writeFileSync(meu, '# não quero esta\n');
        await pagina.goto(base, { waitUntil: 'domcontentloaded' });
        await pagina.setInputFiles('input[data-pick="fim"]', meu);
        await expect(pagina.locator('#bv-itens')).toContainText('descartada.md');
        await pagina.click('[data-limpa="fim"]');
        await expect(pagina.locator('#bv-itens')).toContainText('padrão genérico');
        await expect(pagina.locator('#bv-itens')).not.toContainText('descartada.md');
    });
});

test('sem ser a primeira vez, o portão não aparece', async ({ tela }) => {
    const { pagina, base } = tela;
    await pagina.goto(base, { waitUntil: 'domcontentloaded' });
    await pagina.waitForTimeout(1200);
    await expect(pagina.locator('#modal-boas-vindas')).toHaveCount(0);
});

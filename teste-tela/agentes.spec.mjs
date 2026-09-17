// Contador de agentes na barra e a modal que ele abre.
//
// As sessões são FABRICADAS numa casa do Claude temporária: medir o que a máquina por acaso
// estivesse rodando daria um caso que passa sozinho e falha na máquina de outra pessoa. Os pids
// são os do próprio processo de teste, que é o único jeito honesto de ter pid vivo de verdade.
import { test, expect } from './apoio.mjs';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function casaComSessoes(sessoes) {
    const casa = mkdtempSync(join(tmpdir(), 'casa-claude-'));
    mkdirSync(join(casa, 'sessions'), { recursive: true });
    mkdirSync(join(casa, 'projects', 'proj'), { recursive: true });
    for (const s of sessoes) {
        writeFileSync(join(casa, 'sessions', `${s.pid}.json`), JSON.stringify(s));
        if (s.linhas) {
            writeFileSync(join(casa, 'projects', 'proj', `${s.sessionId}.jsonl`),
                s.linhas.map(l => JSON.stringify(l)).join('\n'));
        }
    }
    return casa;
}

const CASA_CHEIA = casaComSessoes([
    {
        pid: process.pid, sessionId: 'ocupada', name: 'workspace-aa', cwd: '/tmp', kind: 'interactive',
        status: 'busy', startedAt: Date.now() - 8 * 60000,
        linhas: [
            { type: 'user', timestamp: '2026-09-17T12:00:00.000Z', message: { content: 'arrumar o contador da barra' } },
            {
                type: 'assistant', timestamp: '2026-09-17T12:00:09.000Z',
                message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] }
            }
        ]
    },
    {
        pid: process.ppid, sessionId: 'parada', name: 'workspace-bb', cwd: '/tmp', kind: 'interactive',
        status: 'idle', startedAt: Date.now() - 3 * 3600000
    }
]);

const CASA_VAZIA = casaComSessoes([]);

test.describe('com agentes abertos', () => {
    test.use({ casaClaude: CASA_CHEIA });

    test('o botão conta, a bolinha pulsa e a modal diz o que cada um faz', async ({ tela }) => {
        const { pagina, base } = tela;
        await pagina.goto(base);

        const botao = pagina.locator('.conta-sessoes');
        await expect(botao).toBeVisible();
        await expect(botao.locator('.cs-num')).toHaveText('2');
        await expect(botao.locator('.cs-sub')).toHaveText('1 trabalhando agora');
        // A enumeração inteira vive no tooltip: a linha não cabe em 300px, e somar "esperando" com
        // "sem estado informado" seria afirmar o que a CLI antiga não conta.
        await expect(botao).toHaveAttribute('title', /1 trabalhando, 1 esperando/);
        // A bolinha do conjunto pulsa porque ALGUÉM está trabalhando — parada seria outra classe.
        await expect(botao.locator('.bolinha')).toHaveClass(/b-ocupada/);
        // Uma barrinha por agente, e só a do ocupado viva: é o que separa trabalho de esquecimento.
        await expect(botao.locator('.cs-pino')).toHaveCount(2);
        await expect(botao.locator('.cs-pino.viva')).toHaveCount(1);
        await expect(botao).toHaveClass(/viva/);

        await botao.click();
        const modal = pagina.locator('#modal-sessoes');
        await expect(modal).toBeVisible();
        // Teto curto porque o de 15 s do Playwright esconde lentidão. ⚠️ NÃO reproduz a fila cheia
        // do navegador, que é o que fez a modal demorar 3 s de verdade: aqui ela nunca satura.
        await expect(modal.locator('tbody tr')).toHaveCount(2, { timeout: 1500 });
        await expect(modal).toContainText('workspace-aa');
        await expect(modal).toContainText('workspace-bb');
        await expect(modal).toContainText('arrumar o contador da barra');
        await expect(modal).toContainText('Bash');
        await expect(modal).toContainText('npm test');
        // Sem transcript não é o mesmo que sem atividade, e a modal tem que dizer qual dos dois é.
        await expect(modal).toContainText('sem transcript em disco');

        await pagina.keyboard.press('Escape');
        await expect(modal).toBeHidden();
    });

    // A razão de existir das abas: o estado da máquina vale nas TRÊS visões. Quando ele morava
    // dentro de Chamados, sumia na Implantação e nas Configurações — medido antes da mudança.
    test('o contador sobrevive à troca de visão', async ({ tela }) => {
        const { pagina, base } = tela;
        await pagina.goto(base);
        const botao = pagina.locator('.conta-sessoes');
        await expect(botao).toBeVisible();

        for (const [aba, titulo] of [['implantacao', 'Implantação'], ['config', 'Configurações'], ['chamados', 'Magias']]) {
            await pagina.click(`#aba-${aba}`);
            await expect(pagina.locator(`#aba-${aba}`)).toHaveClass(/ativa/);
            await expect(pagina.locator('#titulo-barra')).toContainText(titulo);
            await expect(botao, `o contador sumiu na visão ${aba}`).toBeVisible();
        }
        // Uma visão por vez: o painel escondido não pode continuar ocupando a barra.
        await expect(pagina.locator('.painel:not([hidden])')).toHaveCount(1);
    });
});

test.describe('sem agente nenhum', () => {
    test.use({ casaClaude: CASA_VAZIA });

    test('não desenha botão, em vez de desenhar um que abre nada', async ({ tela }) => {
        const { pagina, base } = tela;
        await pagina.goto(base);
        await expect(pagina.locator('#ocultos')).toBeAttached();
        await expect(pagina.locator('.conta-sessoes')).toHaveCount(0);
    });
});

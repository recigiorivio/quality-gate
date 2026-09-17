// A tela de Configurações — o catálogo de repositórios.
//
// É a tela que mais quebrou durante o desenvolvimento, e sempre do mesmo jeito: o servidor mudava
// de contrato e o cliente ficava para trás, sem nada acusar. O botão "salvar" chegou a passar horas
// mandando um corpo que a rota recusava com 400, e nenhum teste viu porque nenhum teste abria a
// tela. Estes casos existem para que a próxima mudança de contrato falhe aqui, e não no seu clique.
import { test, expect } from './apoio.mjs';

async function abrirCatalogo({ pagina, base }) {
    await pagina.goto(base, { waitUntil: 'domcontentloaded' });
    await pagina.click('#aba-config');
    await pagina.click('.item-config[data-k="repos"]');
    // Espera a tabela PRINCIPAL, não `.tab-repos tbody tr`: esse seletor casa também com a tabela
    // recolhida dos repos sem par, então ele dava a tela por pronta com `#corpo-repos` ainda vazio
    // — e o caso seguinte lia uma lista vazia e ia procurar `tr[data-p="undefined"]`.
    // Teto generoso de propósito: carregar a tela dispara a varredura dos 51 repos do workspace, e
    // o servidor é um processo só — a tabela de repos espera atrás disso. 15 s bastava na máquina
    // ociosa e falhava com ela ocupada, que é a definição de teste intermitente.
    await expect(pagina.locator('#corpo-repos tr').first()).toBeVisible({ timeout: 45000 });
}

test('o catálogo lista os repos com o par de branches de cada um', async ({ tela }) => {
    await abrirCatalogo(tela);
    const { pagina } = tela;
    await expect(pagina.locator('.tab-repos tbody tr')).not.toHaveCount(0);
    // O par fora do padrão é o que a detecção existe para achar: se todo repo aparecer como
    // stage→main, a detecção regrediu para o nome chumbado que ela substituiu.
    const pares = await pagina.locator('#corpo-repos tr').evaluateAll(linhas => linhas.map(l => {
        const campos = l.querySelectorAll('.par-campos input');
        return `${campos[0]?.value} → ${campos[1]?.value}`;
    }));
    expect(pares.some(p => p !== 'origin/stage → origin/main'),
        `nenhum par fora de stage→main: ${[...new Set(pares)].join(', ')}`).toBe(true);
});

test('salvar manda a linha que mudou, e a rota aceita', async ({ tela }) => {
    await abrirCatalogo(tela);
    const { pagina } = tela;
    const linha = pagina.locator('#corpo-repos tr').first();
    const alvo = await linha.locator('.c-nome').innerText();

    const pedidos = [];
    pagina.on('request', r => {
        if (r.url().includes('/api/repos-salvar')) { pedidos.push(r.postDataJSON()); }
    });

    await linha.locator('.par-campos input').first().fill('origin/prova');
    await pagina.keyboard.press('Tab');
    await expect(pagina.locator('#estado-repos')).toHaveText(/não salvo/);
    await pagina.click('header >> text=salvar');
    await expect(pagina.locator('#estado-repos')).not.toHaveText(/salvando/);

    // O contrato: uma linha nomeada, nunca a lista inteira. Mandar tudo é o pedido destrutivo que
    // apagava a edição da outra aba, e a rota o recusa com 400 — quem regredir aqui vê o botão
    // parar de funcionar, que foi exatamente o que aconteceu.
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]).toHaveProperty('repo');
    expect(pedidos[0].repo.projeto).toBe(alvo);
    expect(pedidos[0].repos, 'a lista inteira não pode ir no corpo').toBeUndefined();

    await pagina.reload({ waitUntil: 'domcontentloaded' });
    await pagina.click('#aba-config');
    await pagina.click('.item-config[data-k="repos"]');
    await expect(pagina.locator(`tr[data-p="${alvo}"] .par-campos input`).first()).toHaveValue('origin/prova');
});

// A segunda aba aqui é uma CÓPIA VELHA do catálogo mandando um pedido, não um segundo navegador.
// A versão anterior subia a tela inteira duas vezes — dois boots que varrem 51 repos com git — e
// estourava 180 s sem nunca chegar ao que interessa. O invariante não precisa de dois navegadores:
// precisa de um pedido construído a partir de dado desatualizado, que é o que apagava a edição
// alheia. Testar caro não é testar mais.
test('um pedido montado sobre cópia velha não apaga a edição de quem salvou antes', async ({ tela }) => {
    await abrirCatalogo(tela);
    const { pagina } = tela;

    // A "aba B": a lista inteira, lida ANTES de qualquer edição.
    const copiaVelha = await pagina.evaluate(() => fetch('/api/repos').then(r => r.json()));
    const nomes = await pagina.locator('#corpo-repos tr').evaluateAll(l => l.map(x => x.dataset.p));
    expect(nomes.length, 'o caso precisa de dois repos com par para editar um em cada "aba"')
        .toBeGreaterThanOrEqual(2);
    const [primeiro, segundo] = nomes;

    // A "aba A" edita pela tela e salva.
    await pagina.locator(`tr[data-p="${primeiro}"] .par-campos input`).first().fill('origin/da-aba-A');
    await pagina.keyboard.press('Tab');
    await pagina.click('header >> text=salvar');
    await expect(pagina.locator('#estado-repos')).not.toHaveText(/salvando/);

    // A aba B grava a SUA linha, montada da cópia velha — e não pode levar a edição de A junto.
    const resposta = await pagina.evaluate(async ([copia, alvo]) => {
        const linha = copia.repos.find(r => r.projeto === alvo);
        const r = await fetch('/api/repos-salvar', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ repo: { ...linha, ativo: false } })
        });
        return { status: r.status, corpo: await r.json() };
    }, [copiaVelha, segundo]);
    expect(resposta.status, JSON.stringify(resposta.corpo)).toBe(200);

    const agora = await pagina.evaluate(() => fetch('/api/repos').then(r => r.json()));
    expect(agora.repos.find(r => r.projeto === primeiro).origem,
        'a edição da primeira aba foi apagada por um pedido montado sobre cópia velha').toBe('origin/da-aba-A');
    expect(agora.repos.find(r => r.projeto === segundo).ativo,
        'a edição da segunda aba não gravou').toBe(false);

    // E o pedido destrutivo — a lista inteira sem `substituir` — continua recusado.
    const recusado = await pagina.evaluate(copia => fetch('/api/repos-salvar', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repos: copia.repos })
    }).then(r => r.status), copiaVelha);
    expect(recusado, 'mandar a lista inteira tem que ser recusado, não aceito em silêncio').toBe(400);
});

test('adicionar e remover repo à mão', async ({ tela }) => {
    await abrirCatalogo(tela);
    const { pagina } = tela;
    await pagina.fill('#novo-repo', 'repo-inventado');
    await pagina.fill('#novo-origem', 'origin/homolog');
    await pagina.fill('#novo-destino', 'origin/producao');
    await pagina.click('.repos-novo button');
    await pagina.click('header >> text=salvar');
    await expect(pagina.locator('#estado-repos')).not.toHaveText(/salvando/);

    let catalogo = await pagina.evaluate(() => fetch('/api/repos').then(r => r.json()));
    const novo = catalogo.repos.find(r => r.projeto === 'repo-inventado');
    expect(novo, 'o repo acrescentado à mão não chegou ao catálogo').toBeTruthy();
    expect(novo.fonte, 'linha escrita por gente é manual, e a detecção não pode tocá-la').toBe('manual');

    await pagina.click('tr[data-p="repo-inventado"] .tr-tirar');
    await pagina.click('header >> text=salvar');
    await expect(pagina.locator('#estado-repos')).not.toHaveText(/salvando/);
    catalogo = await pagina.evaluate(() => fetch('/api/repos').then(r => r.json()));
    expect(catalogo.repos.some(r => r.projeto === 'repo-inventado')).toBe(false);
});

test('o botão voltar devolve à seção de onde se veio', async ({ tela }) => {
    const { pagina, base } = tela;
    await pagina.goto(base, { waitUntil: 'domcontentloaded' });
    await pagina.click('#aba-implantacao');
    await expect(pagina.locator('#painel-implantacao')).not.toBeEmpty();

    await pagina.click('#aba-config');
    await expect(pagina.locator('.voltar-config')).toHaveText(/à implantação/);
    await pagina.click('.voltar-config');

    // A aba tem de acompanhar a visão. Antes eram sanfonas que chamavam `trocarVisao` sem nunca
    // serem chamadas por ele, e voltar deixava o título em "Chamados" com a Implantação aberta.
    await expect(pagina.locator('#aba-implantacao')).toHaveClass(/ativa/);
    await expect(pagina.locator('#aba-chamados')).not.toHaveClass(/ativa/);
    await expect(pagina.locator('#painel-chamados')).toBeHidden();
    await expect(pagina.locator('#titulo-barra')).toContainText('Implantação');
});

// Abrir a Implantação disparava 29 pedidos ao mesmo tempo, com `implantacao-detalhe` levando 11,8 s
// cada. O navegador só abre 6 conexões por origem: nessa janela, clicar em Configurações não fazia
// NADA — o pedido saía e ficava preso atrás dos pesados, sem resposta e sem erro na tela. O teto de
// concorrência com fila derrubou o pico para 5 e o clique passou a responder em ~2 s.
test('a tela responde a um clique enquanto a Implantação carrega', async ({ tela }) => {
    const { pagina, base } = tela;
    let pico = 0;
    const emVoo = new Set();
    pagina.on('request', r => {
        if (r.url().includes('/api/')) {
            emVoo.add(r);
            pico = Math.max(pico, emVoo.size);
        }
    });
    pagina.on('requestfinished', r => emVoo.delete(r));
    pagina.on('requestfailed', r => emVoo.delete(r));

    await pagina.goto(base, { waitUntil: 'domcontentloaded' });
    await pagina.click('#aba-implantacao');
    await expect(pagina.locator('.impl-linha').first()).toBeVisible();

    await pagina.click('#aba-config');
    await expect(pagina.locator('.voltar-config')).toBeVisible({ timeout: 20000 });
    expect(pico, `${pico} pedidos ao mesmo tempo: o teto de concorrência caiu`).toBeLessThanOrEqual(8);
});


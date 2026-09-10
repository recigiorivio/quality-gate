// O banco do estado que dois processos escrevem. Cada caso aqui existe por uma perda medida:
// decisão que desaparecia porque o outro processo gravou o arquivo inteiro, edição de repo que a
// segunda aba ressuscitava, e o invariante `fonte: 'manual'` implementado errado duas vezes num dia.
//
// Cada teste roda num diretório próprio: `QUALIDADE_ESTADO` é lido em `abrir()`, então basta
// `fechar()` antes de trocar. Sem isso um caso escreveria no banco de produção.
//
// uso: npm test

import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    abrir, fechar, caminhoBanco, executar, um, todos, paraSql, daLinha, versao, upsert,
    exportarJson, ocupadoMs, paraJson, relatorioImportacao, decisoes, repos, pontos, corridas, TETO_PONTOS
} from '../lib/db.mjs';
import { recusarEstadoDeProducao } from './anteparo.mjs';

recusarEstadoDeProducao();

// Só a variável de ambiente aponta para o diretório, e a chamada seguinte a sobrescreve: sem este
// registro cada execução da suíte deixava 28 diretórios órfãos em /var/folders, para sempre.
const temporarios = [];

function novoDiretorio() {
    fechar();
    const dir = mkdtempSync(join(tmpdir(), 'qualidade-db-'));
    temporarios.push(dir);
    process.env.QUALIDADE_ESTADO = dir;
    return dir;
}

function comparacoesDeExemplo() {
    return {
        'UND-1638|contas-service': {
            via: 'pr', pr: 44, estado: 'MERGED', destino: 'stage', branch: 'UND-1638-descricao',
            base: '58a12f5', head: '555c937', titulo: 'grava a descrição', situacao: 'resolvido',
            nota: 'mesclada mais recente', em: '2026-09-02T18:50:36.173Z'
        },
        'UND-1638|crohc-view': { via: 'stage', branch: 'UND-1638', em: '2026-09-02T18:50:37.000Z' },
        'UND-16|migrate-mongo': { via: 'stage', branch: 'UND-16', em: '2026-09-02T18:50:38.000Z' }
    };
}

function escreverJsonsAntigos(dir) {
    writeFileSync(join(dir, 'comparacoes.json'), JSON.stringify(comparacoesDeExemplo(), null, 2));
    writeFileSync(join(dir, 'pontos-atencao.json'), JSON.stringify({
        teto: 10,
        pontos: [
            { id: 'p1', chamado: 'UND-1638', projeto: 'workflow-manager', severidade: 'aviso', titulo: 'base sem consenso', detalhe: 'x', criadoEm: '2026-08-31' },
            { id: 'p2', chamado: null, projeto: 'crohc-server', severidade: 'nota', titulo: 'dívida antiga', detalhe: 'y', criadoEm: '2026-08-30' }
        ]
    }, null, 2));
    writeFileSync(join(dir, 'repos.json'), JSON.stringify({
        detectadoEm: '2026-09-10T18:02:44.135Z',
        repos: [
            { projeto: 'crohc-server', origem: 'origin/stage', destino: 'origin/main', fonte: 'detectado', ativo: true, motivo: null },
            { projeto: 'migrate-mongo', origem: 'origin/desenv', destino: 'origin/master', fonte: 'manual', ativo: true, motivo: null },
            { projeto: 'argocd', origem: null, destino: 'origin/main', fonte: 'detectado', ativo: false, motivo: 'sem branch de origem' }
        ]
    }, null, 2));
    mkdirSync(join(dir, 'corridas'), { recursive: true });
    writeFileSync(join(dir, 'corridas', 'UND-1862.json'), JSON.stringify({
        chamado: 'UND-1862', modelo: 'opus[1m]', esforco: 'high',
        inicio: '2026-09-03T12:41:23.121Z', fim: '2026-09-03T12:49:00.000Z',
        segundos: 457, ok: true, resumo: 'terminou', erro: null, divergentes: [],
        eventos: [
            { passo: 1, em: '2026-09-03T12:41:26.378Z', texto: 'sessão do agente iniciada' },
            { passo: 2, em: '2026-09-03T12:41:35.227Z', ferramenta: 'Bash', texto: 'sed -n 1,120p x' }
        ]
    }, null, 1));
}

afterEach(() => {
    fechar();
});

// `after` do arquivo roda mesmo com caso falhando, e a limpeza no fim do próprio caso não roda:
// um `assert` que estoura pula o resto do corpo.
after(() => {
    fechar();
    for (const dir of temporarios) {
        rmSync(dir, { recursive: true, force: true });
    }
    temporarios.length = 0;
});

// ── a conexão ─────────────────────────────────────────────────────────────────

// `ferramentas/*.mjs` importam libs às vezes só para imprimir ajuda: se o import criasse o banco,
// um `--help` deixaria arquivo novo em qualquer diretório de onde alguém rodasse a ferramenta.
test('importar o módulo não cria arquivo; abrir() cria', () => {
    novoDiretorio();
    assert.equal(existsSync(caminhoBanco()), false, 'o arquivo apareceu antes de alguém abrir');
    abrir();
    assert.equal(existsSync(caminhoBanco()), true, 'abrir() não criou o banco');
    assert.equal(um('PRAGMA journal_mode').journal_mode, 'wal', 'o banco não ficou em WAL');
    assert.equal(um('PRAGMA foreign_keys').foreign_keys, 1,
        'sem foreign_keys ligado o CASCADE dos eventos não roda');
});

test('abrir() é a mesma instância, e fechar() solta o diretório', () => {
    novoDiretorio();
    assert.equal(abrir(), abrir(), 'abrir() devolveu duas conexões para o mesmo processo');
    const outro = novoDiretorio();
    abrir();
    assert.equal(caminhoBanco(), join(outro, 'qualidade.db'),
        'depois de fechar, QUALIDADE_ESTADO novo tem que valer — é como a suíte se isola');
});

// ── as bordas: boolean, undefined e o protótipo nulo ──────────────────────────

// As três armadilhas medidas do node:sqlite, convertidas num lugar só: o erro do bind não diz
// qual campo estourou, então cada chamador descobriria de novo.
test('boolean e undefined atravessam a borda; objeto é recusado com nome', () => {
    novoDiretorio();
    abrir();
    assert.equal(paraSql(true), 1);
    assert.equal(paraSql(false), 0);
    assert.equal(paraSql(undefined), null);
    assert.equal(paraSql(null), null);
    assert.equal(paraSql(7), 7);
    assert.throws(() => paraSql({ a: 1 }), /JSON.stringify/,
        'objeto posicional vira "Unknown named parameter", que não diz onde está o erro');

    repos.definir({ projeto: 'alfa', origem: 'origin/stage', destino: 'origin/main', ativo: true });
    const linha = repos.obter('alfa');
    assert.equal(linha.ativo, true, 'ativo tem que voltar boolean, não 1');
    assert.equal(linha.motivo, null, 'campo não informado tem que virar null, não undefined');
    assert.equal(typeof linha.hasOwnProperty, 'function',
        'linha com protótipo nulo explode em quem chamar hasOwnProperty');
});

test('daLinha não inventa boolean em campo nulo', () => {
    novoDiretorio();
    abrir();
    assert.equal(daLinha(null), null);
    assert.deepEqual(daLinha({ a: 1, b: 0 }, ['a', 'b']), { a: true, b: false });
    assert.deepEqual(daLinha({ ok: null }, ['ok']), { ok: null },
        'corrida sem fim tem ok nulo — virar false diria que ela falhou');
});

// ── decisões: a chave composta ────────────────────────────────────────────────

// `listar(chamado)` filtrava por `startsWith(chamado + '|')`. Com `UND-16` e `UND-1638` no mesmo
// arquivo isso é um WHERE disfarçado de prefixo de texto, e ele acerta por sorte.
test('decisão é achada pelo par (chamado, projeto), não por prefixo de texto', () => {
    novoDiretorio();
    abrir();
    for (const [chave, decisao] of Object.entries(comparacoesDeExemplo())) {
        const corte = chave.indexOf('|');
        decisoes.definir(chave.slice(0, corte), chave.slice(corte + 1), decisao);
    }
    assert.deepEqual(decisoes.listar('UND-16').map(d => d.projeto), ['migrate-mongo'],
        'o prefixo `UND-16` arrastou as decisões de `UND-1638`');
    assert.deepEqual(decisoes.listar('UND-1638').map(d => d.projeto), ['contas-service', 'crohc-view']);
    assert.equal(decisoes.obter('UND-1638', 'contas-service').pr, 44);
    assert.equal(decisoes.obter('UND-1638', 'nao-existe'), null);
    assert.deepEqual(decisoes.chamados(), ['UND-16', 'UND-1638']);
});

test('definir a mesma decisão de novo atualiza a linha, não duplica', () => {
    novoDiretorio();
    abrir();
    decisoes.definir('UND-1', 'repo', { via: 'stage', branch: 'UND-1' });
    const antes = versao('decisoes');
    decisoes.definir('UND-1', 'repo', { via: 'pr', pr: 9, branch: 'UND-1' });
    assert.equal(decisoes.contar(), 1, 'a segunda decisão criou linha nova');
    assert.equal(decisoes.obter('UND-1', 'repo').via, 'pr');
    assert.equal(decisoes.obter('UND-1', 'repo').pr, 9);
    assert.ok(versao('decisoes') > antes, 'a versão não subiu — o cache do servidor serviria o velho');
    assert.equal(decisoes.remover('UND-1', 'repo'), true);
    assert.equal(decisoes.remover('UND-1', 'repo'), false, 'remover o que não existe tem que dizer false');
});

test('decisão guarda campo que o esquema não conhece', () => {
    novoDiretorio();
    abrir();
    decisoes.definir('UND-2', 'repo', { via: 'stage', branch: 'UND-2', inventado: 'valor novo' });
    assert.equal(decisoes.obter('UND-2', 'repo').inventado, 'valor novo',
        'campo fora do esquema tem que sobreviver, senão a ida e volta perde dado em silêncio');
});

test('a decisão sem chamado continua sendo a chave `?`', () => {
    novoDiretorio();
    abrir();
    decisoes.definir(null, 'repo', { via: 'local' });
    assert.ok(decisoes.mapa()['?|repo'], 'a decisão sem chamado mudou de chave');
});

// ── o que este banco existe para consertar ────────────────────────────────────

// O padrão antigo era ler-alterar-gravar o arquivo inteiro em dois processos. Aqui o segundo
// processo é uma conexão separada, como a ferramenta de CLI que o agente roda.
test('dois escritores no mesmo banco não perdem a escrita do outro', () => {
    novoDiretorio();
    abrir();
    decisoes.definir('UND-3', 'repo-a', { via: 'stage', branch: 'UND-3' });

    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const outroProcesso = new DatabaseSync(caminhoBanco());
    outroProcesso.exec('PRAGMA busy_timeout = 5000');
    outroProcesso.prepare(`INSERT INTO decisoes (chamado, projeto, via, branch, em)
        VALUES (?, ?, 'stage', 'UND-3', '2026-09-10T00:00:00.000Z')`).run('UND-3', 'repo-b');
    outroProcesso.close();

    assert.deepEqual(decisoes.listar('UND-3').map(d => d.projeto), ['repo-a', 'repo-b'],
        'uma das duas escritas desapareceu — é exatamente a perda que motivou o banco');
});

// ── o catálogo de repos ───────────────────────────────────────────────────────

// O invariante virou WHERE: esta instrução não CONSEGUE tocar linha manual. Como blob ele vivia
// em código, e foi implementado errado duas vezes no mesmo dia.
test('a detecção não encosta em linha manual', () => {
    novoDiretorio();
    abrir();
    repos.definir({ projeto: 'migrate-mongo', origem: 'origin/desenv', destino: 'origin/master', fonte: 'manual', ativo: true });
    repos.definir({ projeto: 'crohc-server', origem: 'origin/stage', destino: 'origin/main', fonte: 'detectado', ativo: true });

    repos.gravarDetectados([
        { projeto: 'migrate-mongo', origem: 'origin/stage', destino: 'origin/main', motivo: null },
        { projeto: 'crohc-server', origem: null, destino: 'origin/main', motivo: 'sem branch de origem' }
    ]);

    const manual = repos.obter('migrate-mongo');
    assert.equal(manual.origem, 'origin/desenv', 'a detecção sobrescreveu a correção feita à mão');
    assert.equal(manual.fonte, 'manual');
    const detectado = repos.obter('crohc-server');
    assert.equal(detectado.origem, null, 'a linha detectada tinha que aceitar a detecção nova');
    assert.equal(detectado.ativo, false, 'sem par de branches o repo não pode ficar ativo');
    assert.ok(repos.detectadoEm(), 'a detecção não deixou carimbo de quando rodou');
});

test('detecção apaga repo detectado que saiu do disco e preserva o manual', () => {
    novoDiretorio();
    abrir();
    repos.definir({ projeto: 'foi-embora', origem: 'origin/stage', destino: 'origin/main', fonte: 'detectado', ativo: true });
    repos.definir({ projeto: 'manual-embora', origem: 'origin/stage', destino: 'origin/main', fonte: 'manual', ativo: true });
    repos.gravarDetectados([{ projeto: 'fica', origem: 'origin/stage', destino: 'origin/main', motivo: null }]);

    assert.equal(repos.obter('foi-embora'), null, 'linha detectada de pasta que não existe mais tinha que sair');
    assert.equal(repos.obter('manual-embora').motivo, 'a pasta não existe mais no workspace',
        'sumiu a pasta, não a decisão: entrada manual fica, com o motivo');
    assert.deepEqual(repos.ativos().map(r => r.projeto), ['fica', 'manual-embora']);
});

// A aba B salvava a cópia velha da lista inteira e a edição da aba A desaparecia sem erro.
test('salvar a lista da tela não apaga o repo que não veio nela', () => {
    novoDiretorio();
    abrir();
    repos.salvarVarias([
        { projeto: 'alfa', origem: 'origin/stage', destino: 'origin/main', ativo: true },
        { projeto: 'beta', origem: 'origin/stage', destino: 'origin/main', ativo: true }
    ]);
    repos.salvarVarias([{ projeto: 'alfa', origem: 'origin/desenv', destino: 'origin/main', ativo: true }]);

    assert.equal(repos.obter('beta')?.ativo, true, 'o repo ausente da segunda lista foi apagado');
    assert.equal(repos.obter('alfa').origem, 'origin/desenv', 'a edição não entrou');
    assert.deepEqual(repos.par('alfa'), { origem: 'origin/desenv', destino: 'origin/main' });
    assert.equal(repos.par('beta').destino, 'origin/main');
});

// ── pontos de atenção: o teto de 10 ──────────────────────────────────────────

// O teto é o freio contra a lista virar despejo. Como regra em JS ele valia só para quem chamasse
// a função certa; no esquema, o `INSERT` cru também bate nele.
test('o teto de pontos é do esquema, não da função', () => {
    novoDiretorio();
    abrir();
    for (let i = 0; i < TETO_PONTOS; i++) {
        pontos.gravar({ id: `p${i}`, severidade: 'nota', titulo: `t${i}`, criadoEm: `2026-08-0${i % 10}` });
    }
    assert.equal(pontos.contar(), TETO_PONTOS);
    assert.throws(() => executar(`INSERT INTO pontos (id, severidade, titulo, criadoEm)
        VALUES ('cru', 'nota', 'passando por fora', '2026-09-10')`), /teto de 10/,
        'INSERT cru furou o teto — a regra ficou na função de novo');
    // Regravar um id que já existe não é entrar: sem esta exceção o teto cheio impediria corrigir
    // o texto de um ponto que já está na lista.
    pontos.gravar({ id: 'p1', severidade: 'nota', titulo: 'texto corrigido', criadoEm: '2026-08-01' });
    assert.equal(pontos.obter('p1').titulo, 'texto corrigido');
    assert.equal(pontos.contar(), TETO_PONTOS);
});

test('o descarte por teto olha a severidade antes da idade', () => {
    novoDiretorio();
    abrir();
    pontos.gravar({ id: 'atencao-velho', severidade: 'atencao', titulo: 'a', criadoEm: '2026-01-01' });
    pontos.gravar({ id: 'aviso-velho', severidade: 'aviso', titulo: 'b', criadoEm: '2026-01-02' });
    pontos.gravar({ id: 'nota-nova', severidade: 'nota', titulo: 'c', criadoEm: '2026-09-01' });
    for (let i = 0; i < TETO_PONTOS - 3; i++) {
        pontos.gravar({ id: `enche${i}`, severidade: 'atencao', titulo: `t${i}`, criadoEm: '2026-05-01' });
    }
    const r = pontos.gravar({ id: 'entrando', severidade: 'aviso', titulo: 'novo', criadoEm: '2026-09-10' });
    assert.deepEqual(r.descartados, ['nota-nova'],
        'descartou por idade pura: a nota de hoje tinha que sair antes do atencao de janeiro');
    assert.equal(pontos.obter('atencao-velho').severidade, 'atencao');
    assert.equal(r.total, TETO_PONTOS);
});

test('teto cheio de atencao recusa em vez de apagar o que mais importa', () => {
    novoDiretorio();
    abrir();
    for (let i = 0; i < TETO_PONTOS; i++) {
        pontos.gravar({ id: `a${i}`, severidade: 'atencao', titulo: `t${i}`, criadoEm: '2026-05-01' });
    }
    assert.throws(() => pontos.gravar({ id: 'novo', severidade: 'nota', titulo: 'x' }),
        /todos os pontos são 'atencao'/);
    assert.equal(pontos.contar(), TETO_PONTOS, 'a recusa deixou o banco alterado');
    assert.equal(pontos.obter('novo'), null);
});

test('severidade fora da lista não entra', () => {
    novoDiretorio();
    abrir();
    assert.throws(() => pontos.gravar({ id: 'x', severidade: 'urgentissimo', titulo: 't' }), /severidade/);
    assert.throws(() => pontos.gravar({ severidade: 'nota', titulo: 't' }), /sem id/);
});

// Nulo em chamado/projeto quer dizer "vale para o workspace" — e é o que faz o ponto geral aparecer
// em toda tela em vez de sumir.
test('pontos gerais aparecem em qualquer chamado', () => {
    novoDiretorio();
    abrir();
    pontos.gravar({ id: 'geral', severidade: 'nota', titulo: 'vale sempre' });
    pontos.gravar({ id: 'do-chamado', chamado: 'UND-1', projeto: 'repo', severidade: 'aviso', titulo: 'só aqui' });
    assert.deepEqual(pontos.para('UND-1', 'repo').map(p => p.id).sort(), ['do-chamado', 'geral']);
    assert.deepEqual(pontos.para('UND-9', 'outro').map(p => p.id), ['geral']);
    assert.deepEqual(pontos.para().map(p => p.id), ['geral']);
    assert.equal(pontos.remover('geral').removidos, 1);
    assert.equal(pontos.remover('geral').removidos, 0);
});

// ── corridas: o histórico que o formato antigo não guardava ───────────────────
test('o mesmo chamado guarda várias corridas, ordenadas pelo início', () => {
    novoDiretorio();
    abrir();
    const primeira = corridas.gravar({
        chamado: 'UND-5', modelo: 'opus', inicio: '2026-09-01T10:00:00.000Z',
        fim: '2026-09-01T10:05:00.000Z', segundos: 300, ok: false, erro: 'código 1',
        eventos: [{ passo: 1, texto: 'começou' }]
    });
    const segunda = corridas.gravar({
        chamado: 'UND-5', modelo: 'opus', inicio: '2026-09-02T10:00:00.000Z',
        fim: '2026-09-02T10:04:00.000Z', segundos: 240, ok: true, resumo: 'terminou',
        divergentes: ['repo: PR #1 tem 3, tela mostra 2'],
        eventos: [{ passo: 1, texto: 'começou' }, { passo: 2, ferramenta: 'Bash', texto: 'git log' }]
    });
    assert.notEqual(primeira, segunda, 'a segunda corrida tomou o lugar da primeira');
    assert.equal(corridas.contar('UND-5'), 2);
    assert.deepEqual(corridas.historico('UND-5').map(c => c.id), [segunda, primeira],
        'o histórico tem que vir da mais nova para a mais velha');

    const ultima = corridas.ultima('UND-5');
    assert.equal(ultima.id, segunda);
    assert.equal(ultima.ok, true, 'ok tem que voltar boolean');
    assert.deepEqual(ultima.divergentes, ['repo: PR #1 tem 3, tela mostra 2'],
        'divergentes tem que voltar array, não texto JSON');
    assert.equal(ultima.eventos.length, 2);
    assert.equal(ultima.eventos[1].ferramenta, 'Bash');
    assert.equal(corridas.obter(primeira).ok, false);
    assert.deepEqual(corridas.obter(primeira).divergentes, [], 'corrida sem divergentes tem que dar array vazio');
    assert.deepEqual(corridas.chamados(), ['UND-5']);
});

test('regravar a corrida viva atualiza a mesma linha e troca os eventos', () => {
    novoDiretorio();
    abrir();
    const corrida = { chamado: 'UND-6', inicio: '2026-09-03T09:00:00.000Z', eventos: [{ passo: 1, texto: 'um' }] };
    const id = corridas.gravar(corrida);
    corrida.eventos.push({ passo: 2, texto: 'dois' });
    assert.equal(corridas.gravar(corrida), id, 'a mesma corrida virou linha nova');
    assert.equal(corridas.contar('UND-6'), 1);
    assert.deepEqual(corridas.obter(id).eventos.map(e => e.texto), ['um', 'dois']);
});

test('iniciar/evento/finalizar acompanham a corrida em andamento', () => {
    novoDiretorio();
    abrir();
    const id = corridas.iniciar({ chamado: 'UND-7', modelo: 'opus', esforco: 'high' });
    corridas.evento(id, { passo: 1, texto: 'sessão do agente iniciada' });
    corridas.evento(id, { passo: 2, ferramenta: 'Bash', texto: 'git log' });
    assert.equal(corridas.obter(id).fim, null, 'corrida em andamento não tem fim');
    corridas.finalizar(id, { segundos: 12, ok: true, resumo: 'pronto', divergentes: [] });
    const fim = corridas.obter(id);
    assert.equal(fim.ok, true);
    assert.equal(fim.segundos, 12);
    assert.ok(fim.fim, 'finalizar sem data tinha que carimbar agora');
    assert.equal(fim.eventos.length, 2, 'finalizar apagou os eventos');
});

test('apagar a corrida leva os eventos dela', () => {
    novoDiretorio();
    abrir();
    const id = corridas.gravar({ chamado: 'UND-8', inicio: '2026-09-04T09:00:00.000Z', eventos: [{ passo: 1, texto: 'x' }] });
    assert.equal(corridas.remover(id), true);
    assert.equal(um('SELECT COUNT(*) AS total FROM corrida_eventos').total, 0,
        'evento órfão ficou no banco — o CASCADE depende de PRAGMA foreign_keys');
});

// ── a importação dos JSONs antigos ───────────────────────────────────────────
test('a primeira abertura importa os JSONs e não apaga os arquivos', () => {
    const dir = novoDiretorio();
    escreverJsonsAntigos(dir);
    abrir();

    assert.equal(decisoes.contar(), 3, 'as decisões não vieram do comparacoes.json');
    assert.equal(decisoes.obter('UND-1638', 'contas-service').pr, 44);
    assert.equal(pontos.contar(), 2);
    assert.equal(repos.obter('migrate-mongo').fonte, 'manual', 'a fonte manual não sobreviveu à importação');
    assert.equal(repos.detectadoEm(), '2026-09-10T18:02:44.135Z');
    assert.equal(corridas.contar('UND-1862'), 1);
    assert.equal(corridas.ultima('UND-1862').eventos.length, 2);

    for (const arquivo of ['comparacoes.json', 'pontos-atencao.json', 'repos.json', 'corridas/UND-1862.json']) {
        assert.equal(existsSync(join(dir, arquivo)), true, `${arquivo} foi apagado — ele é o backup de quem migra`);
    }
    const marcas = relatorioImportacao().map(i => i.arquivo).sort();
    assert.deepEqual(marcas,
        ['comparacoes.json', 'corridas/UND-1862.json', 'pontos-atencao.json', 'repos.json'],
        'sem a marca de importação o boot seguinte reimporta por cima da edição nova');
});

test('a segunda abertura não reimporta por cima do que mudou depois', () => {
    const dir = novoDiretorio();
    escreverJsonsAntigos(dir);
    abrir();
    decisoes.definir('UND-1638', 'contas-service', { via: 'pr', pr: 99, branch: 'UND-1638' });
    decisoes.remover('UND-1638', 'crohc-view');
    fechar();

    abrir();
    assert.equal(decisoes.obter('UND-1638', 'contas-service').pr, 99,
        'a importação rodou de novo e devolveu o número velho da PR');
    assert.equal(decisoes.obter('UND-1638', 'crohc-view'), null,
        'a decisão apagada voltou do arquivo — o JSON é backup, não fonte');
    assert.equal(decisoes.contar(), 2);
});

test('banco já em uso e JSON aparecendo depois: importa nada e diz por quê', () => {
    const dir = novoDiretorio();
    abrir();
    decisoes.definir('UND-9', 'repo', { via: 'stage', branch: 'UND-9' });
    fechar();

    escreverJsonsAntigos(dir);
    abrir();
    assert.equal(decisoes.contar(), 1, 'importou por cima de um banco que já estava em uso');
    const marca = relatorioImportacao().find(i => i.arquivo === 'comparacoes.json');
    assert.equal(marca.linhas, 0);
    assert.match(marca.observacao, /já tinha 1 linhas/, 'a marca tem que dizer por que não importou');
    assert.equal(pontos.contar(), 2, 'as tabelas vazias ainda tinham que ser importadas');
});

test('JSON quebrado grita em vez de importar vazio', () => {
    const dir = novoDiretorio();
    writeFileSync(join(dir, 'repos.json'), '{"repos": [');
    assert.throws(() => abrir(), /repos.json não é JSON válido/,
        'seguir com o padrão apagaria o estado da pessoa por cima do defeito');
});

// ── a saída inspecionável ────────────────────────────────────────────────────
// O argumento pró-arquivo era `grep` e editor. Sem isto a migração tiraria uma capacidade real.
test('exportar devolve JSON legível e com o mesmo conteúdo do banco', () => {
    const dir = novoDiretorio();
    escreverJsonsAntigos(dir);
    abrir();
    const { destino, arquivos } = exportarJson();
    assert.ok(arquivos.length >= 4, `exportou só ${arquivos.length} arquivos`);

    const comparacoes = JSON.parse(readFileSync(join(destino, 'comparacoes.json'), 'utf8'));
    assert.deepEqual(Object.keys(comparacoes).sort(),
        ['UND-1638|contas-service', 'UND-1638|crohc-view', 'UND-16|migrate-mongo'],
        'a chave exportada tem que ser a mesma do arquivo antigo, para o grep continuar valendo');
    assert.equal(comparacoes['UND-1638|contas-service'].pr, 44);
    assert.equal('url' in comparacoes['UND-1638|crohc-view'], false,
        'coluna vazia não pode virar campo nulo no JSON exportado');

    const catalogo = JSON.parse(readFileSync(join(destino, 'repos.json'), 'utf8'));
    assert.equal(catalogo.repos.find(r => r.projeto === 'migrate-mongo').ativo, true,
        'ativo tem que sair boolean no JSON, não 1');
    const corrida = JSON.parse(readFileSync(join(destino, 'corridas', 'UND-1862.json'), 'utf8'));
    assert.equal(corrida.corridas[0].eventos.length, 2);
    assert.equal(paraJson().pontosAtencao.teto, TETO_PONTOS);
});

// ── as ferramentas de SQL cru ────────────────────────────────────────────────
test('upsert só atualiza o que a condição permite', () => {
    novoDiretorio();
    abrir();
    upsert('meta', ['chave'], { chave: 'x', valor: 'primeiro' });
    upsert('meta', ['chave'], { chave: 'x', valor: 'segundo' });
    assert.equal(um('SELECT valor FROM meta WHERE chave = ?', 'x').valor, 'segundo');
    const linhas = todos('SELECT * FROM meta WHERE chave = ?', 'x');
    assert.equal(linhas.length, 1, 'o upsert duplicou a linha em vez de atualizar');
});

// ── a conexão que falha no meio ──────────────────────────────────────────────

// `abrir()` retorna cedo quando `banco` existe: publicado antes do esquema, o banco pela metade
// fica para sempre — e o gatilho é o mais provável, porque JSON quebrado grita de propósito.
test('abrir() que falha não deixa banco pela metade publicado no processo', () => {
    const dir = novoDiretorio();
    writeFileSync(join(dir, 'repos.json'), '{"repos": [');
    assert.throws(() => abrir(), /repos.json não é JSON válido/);

    writeFileSync(join(dir, 'repos.json'), JSON.stringify({ repos: [{ projeto: 'crohc-server' }] }));
    abrir();
    assert.equal(repos.contar(), 1,
        'a segunda abertura devolveu a conexão envenenada da primeira, sem esquema nem importação');
});

// ── a importação incremental ─────────────────────────────────────────────────

// Medido no banco de produção: a marca de PASTA ficou 7,5 s antes de o servidor gravar
// `corridas/UND-2026.json`, e por isso aquela corrida nunca entraria.
test('corrida que aparece depois da primeira abertura ainda é importada', () => {
    const dir = novoDiretorio();
    escreverJsonsAntigos(dir);
    abrir();
    assert.equal(corridas.contar(), 1);
    fechar();

    writeFileSync(join(dir, 'corridas', 'UND-2026.json'), JSON.stringify({
        chamado: 'UND-2026', inicio: '2026-09-10T16:40:00.000Z', ok: true, eventos: []
    }));
    abrir();
    assert.equal(corridas.contar('UND-2026'), 1, 'a corrida gravada depois da marca ficou de fora');
    assert.equal(corridas.contar(), 2);
});

test('pasta corridas vazia na primeira abertura não sela a fonte', () => {
    const dir = novoDiretorio();
    mkdirSync(join(dir, 'corridas'), { recursive: true });
    abrir();
    fechar();

    writeFileSync(join(dir, 'corridas', 'UND-7.json'), JSON.stringify({
        chamado: 'UND-7', inicio: '2026-09-10T10:00:00.000Z', eventos: []
    }));
    abrir();
    assert.equal(corridas.contar('UND-7'), 1, 'a marca da pasta vazia selou a fonte para sempre');
});

test('a corrida já importada não é reescrita pelo arquivo velho', () => {
    const dir = novoDiretorio();
    escreverJsonsAntigos(dir);
    abrir();
    const id = corridas.ultima('UND-1862').id;
    corridas.finalizar(id, { resumo: 'editado depois da importação' });
    // A marca por arquivo some, como acontece com quem migrou antes da correção.
    executar('DELETE FROM importacoes');
    fechar();

    abrir();
    assert.equal(corridas.obter(id).resumo, 'editado depois da importação',
        'o arquivo de backup sobrescreveu a corrida que já estava no banco');
    const marca = relatorioImportacao().find(i => i.arquivo === 'corridas/UND-1862.json');
    assert.match(marca.observacao, /já estavam no banco/);
});

// ── o teto de pontos na importação ───────────────────────────────────────────

// A regra de `ferramentas/pontos.mjs`: sai a `nota` mais antiga, depois o `aviso` mais antigo, e
// `atencao` nunca sai. Por ordem de array, era o `atencao` da posição 11 que caía.
test('o corte do teto na importação é por severidade, não por posição no array', () => {
    const dir = novoDiretorio();
    const lista = [];
    for (let i = 0; i < 10; i++) {
        lista.push({ id: `nota-${i}`, severidade: 'nota', titulo: `n${i}`, criadoEm: '2026-08-01' });
    }
    lista.push({ id: 'aviso-tardio', severidade: 'aviso', titulo: 'a', criadoEm: '2026-09-01' });
    lista.push({ id: 'atencao-na-ponta', severidade: 'atencao', titulo: 'x', criadoEm: '2026-09-09' });
    writeFileSync(join(dir, 'pontos-atencao.json'), JSON.stringify({ teto: 10, pontos: lista }));
    abrir();

    const ids = pontos.listar().map(p => p.id);
    assert.equal(pontos.contar(), TETO_PONTOS);
    assert.ok(ids.includes('atencao-na-ponta'), 'o atencao da posição 11 foi descartado pela ordem do array');
    assert.ok(ids.includes('aviso-tardio'), 'o aviso perdeu a vaga para uma nota');
    const marca = relatorioImportacao().find(i => i.arquivo === 'pontos-atencao.json');
    assert.match(marca.observacao, /ficaram fora do teto/, 'quem ficou de fora tem que estar dito na marca');
});

// ── o registro que o esquema recusa ──────────────────────────────────────────

// Valor fora do enum em JSON VÁLIDO derrubava `abrir()`, e a marca ia na mesma transação: sem
// progresso nenhum, caía a tela inteira e todas as ferramentas, em toda abertura.
test('severidade fora do enum recusa o registro e deixa o resto entrar', () => {
    const dir = novoDiretorio();
    writeFileSync(join(dir, 'pontos-atencao.json'), JSON.stringify({
        teto: 10,
        pontos: [
            { id: 'bom', severidade: 'aviso', titulo: 'entra', criadoEm: '2026-09-01' },
            { id: 'torto', severidade: 'urgentissimo', titulo: 'não entra', criadoEm: '2026-09-02' }
        ]
    }));
    abrir();

    assert.equal(pontos.contar(), 1);
    assert.equal(pontos.obter('bom').titulo, 'entra');
    assert.equal(pontos.obter('torto'), null, 'severidade inventada não pode ser normalizada em silêncio');
    const marca = relatorioImportacao().find(i => i.arquivo === 'pontos-atencao.json');
    assert.match(marca.observacao, /torto.*urgentissimo/, 'o motivo da recusa tem que ficar registrado');
});

// ── a ida e volta ────────────────────────────────────────────────────────────

// `exportarJson` grava a corrida AGRUPADA e a importação lia corrida chata: realimentar o export
// gravava uma corrida vazia com o início de agora, sem erro, e perdia o histórico.
test('o que exportarJson grava, uma abertura nova reimporta igual', () => {
    const dir = novoDiretorio();
    escreverJsonsAntigos(dir);
    abrir();
    corridas.gravar({
        chamado: 'UND-1862', inicio: '2026-09-04T08:00:00.000Z', ok: false, resumo: 'a segunda',
        eventos: [{ passo: 1, texto: 'começou' }]
    });
    const antes = paraJson();
    const { destino } = exportarJson(join(dir, 'ida-e-volta'));
    fechar();

    process.env.QUALIDADE_ESTADO = destino;
    abrir();
    const depois = paraJson();
    assert.deepEqual(depois.comparacoes, antes.comparacoes);
    assert.deepEqual(depois.pontosAtencao.pontos, antes.pontosAtencao.pontos);
    assert.deepEqual(depois.repos.repos, antes.repos.repos);
    assert.equal(corridas.contar('UND-1862'), 2, 'as duas corridas do grupo tinham que voltar');
    assert.deepEqual(corridas.ultima('UND-1862').eventos, antes.corridas[0].corridas[0].eventos);
});

test('gravar uma corrida agrupada grita em vez de gravar uma corrida vazia', () => {
    novoDiretorio();
    abrir();
    assert.throws(() => corridas.gravar({ chamado: 'UND-9', corridas: [{ inicio: '2026-09-01T00:00:00.000Z' }] }),
        /grupo/, 'o arquivo do export realimentado corrompia em silêncio');
});

// O mesmo número é a espera do segundo processo E o teto do congelamento da tela, porque
// `node:sqlite` é síncrono: medido, 5000 parava toda requisição por 2,7 s com o banco travado.
test('busy_timeout chega ao banco e QUALIDADE_BUSY_MS manda nele', () => {
    novoDiretorio();
    delete process.env.QUALIDADE_BUSY_MS;
    assert.equal(abrir().prepare('PRAGMA busy_timeout').get().timeout, ocupadoMs());

    fechar();
    process.env.QUALIDADE_BUSY_MS = '250';
    try {
        assert.equal(ocupadoMs(), 250);
        assert.equal(abrir().prepare('PRAGMA busy_timeout').get().timeout, 250,
            'o pragma não acompanhou a variável — o número medido não é o que vale em execução');
    } finally {
        delete process.env.QUALIDADE_BUSY_MS;
    }
});

// ── a importação não pode engolir nem morrer ─────────────────────────────────
// Três defeitos da mesma família, todos reproduzidos: importação que devolve zero linha e SELA a
// fonte é indistinguível de "o arquivo estava vazio", e foi assim que uma corrida real do usuário
// (escrita 7 s depois da marca da pasta) ficou fora do banco para sempre.
test('arquivo válido com forma irreconhecível é recusado, não importado como zero', () => {
    const d = novoDiretorio();
    writeFileSync(join(d, 'repos.json'), JSON.stringify({ repositorios: [{ projeto: 'p1' }] }));
    assert.throws(() => abrir(), /forma esperada/,
        'chave errada tem que gritar; zero linha só pode significar arquivo vazio');
});

test('o array cru é aceito como forma alternativa', () => {
    const d = novoDiretorio();
    writeFileSync(join(d, 'repos.json'),
        JSON.stringify([{ projeto: 'p1', origem: 'origin/a', destino: 'origin/b', ativo: true }]));
    abrir();
    assert.equal(repos.contar(), 1);
});

test('uma corrida ilegível não derruba o boot — é recusada com o motivo', () => {
    const d = novoDiretorio();
    mkdirSync(join(d, 'corridas'), { recursive: true });
    writeFileSync(join(d, 'corridas', 'BOA.json'),
        JSON.stringify({ chamado: 'BOA', inicio: '2026-01-01T00:00:00.000Z', eventos: [] }));
    writeFileSync(join(d, 'corridas', 'PODRE.json'), '{"chamado": ');
    abrir();
    assert.equal(corridas.contar(), 1, 'a corrida boa tem que entrar mesmo com a podre ao lado');
    const marca = todos('SELECT arquivo, observacao FROM importacoes')
        .find(l => l.arquivo.includes('PODRE'));
    assert.ok(marca, 'a recusa tem que deixar marca — recusar não é engolir');
    assert.match(marca.observacao, /recusado/);
});

test('corrida que aparece DEPOIS da marca ainda entra', () => {
    const d = novoDiretorio();
    mkdirSync(join(d, 'corridas'), { recursive: true });
    writeFileSync(join(d, 'corridas', 'A.json'),
        JSON.stringify({ chamado: 'A', inicio: '2026-01-01T00:00:00.000Z', eventos: [] }));
    abrir();
    assert.equal(corridas.contar(), 1);
    fechar();
    writeFileSync(join(d, 'corridas', 'A.json'),
        JSON.stringify({ chamado: 'A', inicio: '2026-06-06T00:00:00.000Z', eventos: [] }));
    writeFileSync(join(d, 'corridas', 'B.json'),
        JSON.stringify({ chamado: 'B', inicio: '2026-07-07T00:00:00.000Z', eventos: [] }));
    abrir();
    assert.equal(corridas.contar(), 3,
        'a marca por arquivo não pode trancar a fonte: o corte é por (chamado, início)');
});


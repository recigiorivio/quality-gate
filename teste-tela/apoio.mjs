// Fixture da tela: cada arquivo de teste sobe O SEU servidor, em porta livre e com estado
// temporário. Nunca o de trabalho na 4100.
//
// Isto existe por causa de um erro de método que custou caro. Durante o desenvolvimento eu
// verifiquei a tela quatro vezes apontando o navegador para o servidor de trabalho — e quatro
// vezes a escolha de repos do usuário foi apagada e restaurada à mão. O log entregou a prova:
// quatro pedidos `sai=` em dois segundos contra a porta 4100. `QUALIDADE_ESTADO` nunca ia resolver,
// porque quem escrevia era o servidor de verdade, não o processo do teste.
//
// A causa de fundo é o Playwright ser resiliente: `click()` reencontra o elemento depois de
// "element detached from the DOM" e clica de novo. Contra uma lista que se redesenha, cada nova
// tentativa acerta o nó que ocupou o lugar — foi assim que os repos saíram um a um. Com servidor
// próprio, esse comportamento continua existindo e deixa de ter consequência.
import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));

// Porta 0 faz o SO escolher uma livre e o servidor anunciar qual foi. Porta fixa colidia entre
// suítes concorrentes — duas rodando ao mesmo tempo nesta máquina davam números de outro processo.
function subirServidor(estado, casaClaude) {
    return new Promise((resolve, reject) => {
        const filho = spawn('node', ['--disable-warning=ExperimentalWarning', 'server.mjs'], {
            cwd: RAIZ,
            env: {
                ...process.env, PORT: '0', QUALIDADE_HOST: '127.0.0.1', QUALIDADE_TOKEN: '',
                QUALIDADE_ESTADO: estado,
                // O `.env` também vai para o diretório do caso: trocar a raiz no portão GRAVA
                // `QUALIDADE_WORKSPACE`, e sem isto a suíte apontava a tela do próprio
                // desenvolvedor para uma pasta temporária que ela apaga no fim.
                QUALIDADE_ENV: join(estado, '.env'),
                // Sem isto o contador de agentes mediria o que a máquina por acaso estivesse rodando.
                ...(casaClaude ? { QUALIDADE_CLAUDE_HOME: casaClaude } : {})
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const linhas = [];
        const saida = () => linhas.join('');
        const aoSair = () => reject(new Error(`o servidor morreu antes de anunciar a porta:\n${saida()}`));
        filho.on('exit', aoSair);
        filho.stdout.on('data', d => {
            linhas.push(String(d));
            const porta = saida().match(/:(\d{2,5})\b/);
            if (porta) {
                filho.off('exit', aoSair);
                resolve({ filho, base: `http://127.0.0.1:${porta[1]}`, log: saida });
            }
        });
        filho.stderr.on('data', d => linhas.push(String(d)));
        setTimeout(() => reject(new Error(`o servidor não anunciou porta em 20 s:\n${saida}`)), 20000);
    });
}

// Pela MESMA rota que a tela usa, não por um atalho de teste: corpo vazio não planta arquivo nem
// mexe no `.env` — grava só a marca de instalado, no estado temporário do caso.
async function marcarInstalado(base) {
    const r = await fetch(`${base}/api/primeira-vez-salvar`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    if (!r.ok) {
        throw new Error(`não consegui marcar a instalação: HTTP ${r.status}`);
    }
}

export const test = base.extend({
    // Casa do Claude que o caso quer que o servidor enxergue. Quem não declara vê a de verdade.
    casaClaude: [undefined, { option: true }],

    // O portão da primeira abertura aparece por cima de tudo enquanto o estado não tiver a marca de
    // instalado — e estado temporário nunca tem. Quem não é caso DELE já nasce instalado.
    primeiraVez: [false, { option: true }],

    // Um estado por ARQUIVO de teste, não por caso: subir servidor custa ~1 s, e os casos de tela
    // leem muito mais do que escrevem. Quem escreve declara o que mexeu e devolve.
    tela: [async ({ browser, casaClaude, primeiraVez }, usar, info) => {
        const estado = mkdtempSync(join(tmpdir(), 'tela-'));
        // O catálogo de repos e as decisões vêm de cópia do estado real quando ele existe: a tela
        // sem dado nenhum não exercita ordenação, filtro nem os pares fora do padrão.
        for (const arquivo of ['repos.json', 'comparacoes.json', 'implantacao.json']) {
            if (existsSync(join(RAIZ, arquivo))) {
                cpSync(join(RAIZ, arquivo), join(estado, arquivo));
            }
        }
        let servidor = null;
        try {
            servidor = await subirServidor(estado, casaClaude);
            if (!primeiraVez) {
                await marcarInstalado(servidor.base);
            }
            const pagina = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
            const erros = [];
            pagina.on('pageerror', e => erros.push(String(e)));
            // qualidade:ok comentario-bloco-longo
            // "Failed to load resource: … 400" é log de REDE do navegador, não exceção de JS — e um
            // caso que prova que a rota recusa um pedido inválido gera esse log de propósito. O que
            // interessa é erro vindo do código da tela; o status HTTP quem afirma é a asserção.
            pagina.on('console', m => {
                if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
                    erros.push(`console: ${m.text()}`);
                }
            });
            await usar({ pagina, base: servidor.base, erros, estado });
            // Erro de JS na tela reprova o caso mesmo quando as asserções passam: a tela "funciona"
            // com exceção no console até a hora em que o pedaço que estourou é o que você precisa.
            expect(erros, 'a tela não pode acumular erro de JS').toEqual([]);
            await pagina.close();
        } finally {
            // qualidade:ok comentario-bloco-longo
            // Caso que falha imprime o log do SERVIDOR. Sem isto, uma falha de tela dizia só
            // "elemento não encontrado" e eu passava rodadas adivinhando se o problema era a tela,
            // a rota ou a máquina — três vezes cheguei à conclusão errada por falta deste texto.
            if (info.status !== info.expectedStatus && servidor) {
                const texto = servidor.log().trim();
                console.log(`\n--- servidor de "${info.title}" (estado ${estado}) ---\n${
                    texto.split('\n').slice(-25).join('\n')}\n---`);
            }
            servidor?.filho.kill();
            rmSync(estado, { recursive: true, force: true });
        }
    }, { scope: 'test' }]
});

export { expect };

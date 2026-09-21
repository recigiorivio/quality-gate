// Registro e remoção dos gatilhos no `.claude/settings.json` do workspace.
//
// Duas razões para a lógica morar aqui, e não no CLI: ela é o único lugar do projeto que escreve em
// arquivo de configuração de outra ferramenta — então precisa de teste — e a desinstalação tem de
// remover exatamente o que a instalação pôs, o que só é verdade se as duas leem a mesma regra.
//
// A regra é "aditivo e reconhecível pelo caminho": cada entrada aponta para o `hook/gate.mjs` DESTE
// clone, e é por esse caminho que a remoção sabe o que é dela. Assim dois clones convivem, e
// desinstalar um não desliga o outro.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIGS, comCaminhos } from './configs.mjs';

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));

const EVENTOS = [
    { evento: 'UserPromptSubmit', argumento: 'prompt', timeout: 20, matcher: null },
    { evento: 'PreToolUse', argumento: 'pretooluse', timeout: 120, matcher: 'Bash' },
    { evento: 'PostToolUse', argumento: 'posttooluse', timeout: 20, matcher: 'Bash' }
];

// O que conta como "a pessoa sinalizou fim de trabalho".
//
// Mora aqui, e não dentro do `gate.mjs`, para ter teste: importar o hook o executa.
//
// A assimetria que decide a forma: **deixar de disparar custa o projeto inteiro**, e disparar demais
// custa uma injeção — e mesmo essa é limitada, porque o gate tem marca de uma vez por dia por
// chamado. Por isso as formas verbais entram por prefixo, e não por lista fechada: `\bcommit\b` não
// casa em "commit-ar", e era assim que "commite tudo" — o jeito como o trabalho é pedido aqui — não
// disparava nada.
//
// `\b` não serve de fronteira aqui: letra acentuada não é `\w`, então `\bpr\b` casa dentro de
// "**pr**óximo" (e de "prévia", "prático") e injetava a rotina de fim em quem só disse "próximo
// passo". A fronteira precisa incluir acento nos DOIS lados — e o `*` do prefixo também, senão
// "finalização" para no `ç` e deixa de casar.
const LETRA = String.raw`[0-9A-Za-z_À-ÿ]`;

// `comit` de um `m` vai enumerado: por prefixo casaria "comitê", que é substantivo.
const GATILHOS_FIM = [
    String.raw`commit${LETRA}*`,
    String.raw`comit(a|ar|ando|ei|e|ou|amos)`,
    String.raw`push${LETRA}*`,
    String.raw`merge${LETRA}*`,
    String.raw`mescl${LETRA}*`,
    String.raw`finaliz${LETRA}*`,
    String.raw`entreg${LETRA}*`,
    String.raw`subir`,
    String.raw`sobe`,
    String.raw`pr`,
    String.raw`fechar o chamado`,
    String.raw`abrir o pr`
];

const PADRAO_FIM = new RegExp(`(?<!${LETRA})(${GATILHOS_FIM.join('|')})(?!${LETRA})`, 'i');

export function ehFimDeTrabalho(prompt) {
    return PADRAO_FIM.test(String(prompt || ''));
}

export function caminhoSettings(workspace) {
    return join(workspace, '.claude', 'settings.json');
}

// Settings ilegível não é "vazio": sobrescrever um JSON quebrado apagaria configuração que a pessoa
// tem e não sabe que está com erro de sintaxe.
export function lerSettings(caminho) {
    if (!existsSync(caminho)) {
        return { settings: {}, existia: false };
    }
    const bruto = readFileSync(caminho, 'utf8');
    try {
        return { settings: JSON.parse(bruto), existia: true };
    } catch (e) {
        throw new Error(`${caminho} não é JSON válido (${e.message}) — arrume à mão antes`);
    }
}

function comando(projeto, argumento) {
    return `node ${join(projeto, 'hook', 'gate.mjs')} ${argumento}`;
}

function eDoClone(gancho, projeto) {
    return typeof gancho?.command === 'string' && gancho.command.includes(join(projeto, 'hook', 'gate.mjs'));
}

function eDoGate(gancho) {
    return typeof gancho?.command === 'string' && gancho.command.includes(join('hook', 'gate.mjs'));
}

// O que já está registrado por este clone, por evento. Base da idempotência: `--add` rodado duas
// vezes não pode duplicar entrada.
export function jaRegistrados(settings, projeto) {
    return EVENTOS.filter(({ evento }) => (settings?.hooks?.[evento] || [])
        .some(g => (g?.hooks || []).some(h => eDoClone(h, projeto)))).map(e => e.evento);
}

// Gatilhos de OUTRO clone do quality-gate. Não são conflito nem erro: rodam os dois, e a rotina
// chega duas vezes. Quem instala precisa saber disso antes de gravar, não depois de estranhar.
export function outrosClones(settings, projeto) {
    const fora = new Set();
    for (const { evento } of EVENTOS) {
        for (const grupo of settings?.hooks?.[evento] || []) {
            for (const gancho of grupo?.hooks || []) {
                if (eDoGate(gancho) && !eDoClone(gancho, projeto)) {
                    fora.add(gancho.command.replace(/^node\s+/, '').replace(/\s+\w+$/, ''));
                }
            }
        }
    }
    return [...fora];
}

export function comGatilhos(settings, projeto) {
    const novo = estruturaClonada(settings);
    novo.hooks = { ...(novo.hooks || {}) };
    for (const { evento, argumento, timeout, matcher } of EVENTOS) {
        const grupos = [...(novo.hooks[evento] || [])];
        if (grupos.some(g => (g?.hooks || []).some(h => eDoClone(h, projeto)))) {
            continue;
        }
        const grupo = { hooks: [{ type: 'command', command: comando(projeto, argumento), timeout }] };
        if (matcher) {
            grupo.matcher = matcher;
        }
        novo.hooks[evento] = [...grupos, grupo];
    }
    return novo;
}

// Remove só o que aponta para este clone, e limpa o que ficou vazio: grupo sem gancho e evento sem
// grupo são lixo que confunde a próxima leitura do arquivo.
export function semGatilhos(settings, projeto) {
    const novo = estruturaClonada(settings);
    if (!novo.hooks) {
        return novo;
    }
    novo.hooks = { ...novo.hooks };
    for (const { evento } of EVENTOS) {
        const grupos = (novo.hooks[evento] || [])
            .map(g => ({ ...g, hooks: (g?.hooks || []).filter(h => !eDoClone(h, projeto)) }))
            .filter(g => g.hooks.length);
        if (grupos.length) {
            novo.hooks[evento] = grupos;
        } else {
            delete novo.hooks[evento];
        }
    }
    if (!Object.keys(novo.hooks).length) {
        delete novo.hooks;
    }
    return novo;
}

function estruturaClonada(settings) {
    return JSON.parse(JSON.stringify(settings || {}));
}

// Backup antes de gravar, sempre. É arquivo que a pessoa escreveu, e a única coisa pior que não
// instalar é instalar e perder o que estava ali.
export function gravarSettings(caminho, settings) {
    mkdirSync(dirname(caminho), { recursive: true });
    const backup = existsSync(caminho) ? `${caminho}.bak` : null;
    if (backup) {
        writeFileSync(backup, readFileSync(caminho));
    }
    writeFileSync(caminho, `${JSON.stringify(settings, null, 2)}\n`);
    return backup;
}

// O que o `CONFIGS` promete e o workspace não tem. Não é só cosmética de status: versão nova que
// acrescenta um padrão (foi o caso do `quality-subir-tela`) não alcançava quem já tinha passado pelo
// portão da primeira abertura — o arquivo existia no repo e nunca chegava a ninguém.
export function faltando(workspace) {
    return Object.entries(CONFIGS)
        .filter(([, c]) => !existsSync(join(workspace, c.caminho)) && existsSync(caminhoPadrao(c.caminho)))
        .map(([chave, c]) => ({ chave, caminho: c.caminho, rotulo: c.rotulo, resumo: c.resumo }));
}

// O padrão é achado pelo nome do próprio alvo: um segundo mapa de-para seria mais uma coisa para
// divergir do `CONFIGS` sem ninguém perceber.
export function caminhoPadrao(caminho) {
    return join(RAIZ, 'padroes', basename(caminho));
}

// Nunca sobrescreve, como na instalação: arquivo que já existe é rotina do time.
//
// E reescreve os `{{CLONE}}`/`{{TELA}}` com o caminho real deste clone: rotina plantada com comando
// que não roda é pior que rotina sem comando.
export function plantar(workspace, chaves, projeto = RAIZ, porta = 4100) {
    const escritos = [];
    for (const chave of chaves) {
        const c = CONFIGS[chave];
        const origem = c && caminhoPadrao(c.caminho);
        const destino = c && join(workspace, c.caminho);
        if (!c || !existsSync(origem) || existsSync(destino)) {
            continue;
        }
        mkdirSync(dirname(destino), { recursive: true });
        writeFileSync(destino, comCaminhos(readFileSync(origem, 'utf8'), { clone: refDoClone(workspace, projeto), porta }));
        escritos.push(c.caminho);
    }
    return escritos;
}

// Relativo quando o clone está DENTRO do workspace (é o caso normal, e o comando fica curto);
// absoluto quando está fora, senão o comando plantado não acha o arquivo.
export function refDoClone(workspace, projeto = RAIZ) {
    const r = relative(workspace, projeto);
    return !r || r.startsWith('..') ? projeto : r;
}

export function plantados(workspace) {
    return Object.values(CONFIGS)
        .map(c => ({ caminho: c.caminho, rotulo: c.rotulo, absoluto: join(workspace, c.caminho) }))
        .filter(c => existsSync(c.absoluto));
}

// Guarda `.bak` antes de apagar em vez de apagar direto: a rotina plantada é ponto de partida, e a
// chance de a pessoa ter editado e querer o texto de volta é alta.
export function removerPlantados(workspace) {
    const removidos = [];
    for (const c of plantados(workspace)) {
        writeFileSync(`${c.absoluto}.bak`, readFileSync(c.absoluto));
        rmSync(c.absoluto);
        removidos.push(c.caminho);
    }
    return removidos;
}

export { EVENTOS };

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
import { join, dirname } from 'node:path';
import { CONFIGS } from './configs.mjs';

const EVENTOS = [
    { evento: 'UserPromptSubmit', argumento: 'prompt', timeout: 20, matcher: null },
    { evento: 'PreToolUse', argumento: 'pretooluse', timeout: 120, matcher: 'Bash' },
    { evento: 'PostToolUse', argumento: 'posttooluse', timeout: 20, matcher: 'Bash' }
];

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

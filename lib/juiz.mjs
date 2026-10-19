// O "Pergunte ao The Judge": a skill the-judge revisando a PR do chamado, com o resultado num modal e
// NADA publicado — nem review no GitHub, nem commit, nem push.
//
// A skill termina no passo 7, que publica a revisão pelo `gh`. Aqui ela para no 6 (o portão), e a
// garantia não está no prompt: o `claude -p` roda com `--restricted --tools Read,Grep,Glob,WebSearch,
// WebFetch --strict-mcp-config`, sem Bash, sem escrita e sem conectores. Medido antes de confiar: com
// `--allowedTools` a escrita passou mesmo assim (o modo padrão do usuário libera edição no diretório),
// e com `--permission-mode default` a corrida ficou 3 min esperando uma aprovação que não vinha. Com
// `--restricted`, Write e Bash "indisponíveis", leitura fora das pastas recusada, e nada trava.
//
// O que a skill faz com comando (passos 0, 1 e 6) roda AQUI e vai pronto no prompt: dados da PR, diff,
// revisões anteriores, varredura de bypasses, lint e o portão. Teste do repo não roda — o `npm test`
// do migrate-mongo apaga o banco local, e o juiz rodaria em qualquer repo.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { WORKSPACE } from './diff.mjs';
import { caminhoEstado } from './db.mjs';
import lint from './lint.mjs';

const execFileAsync = promisify(execFile);

export class Juiz {
    static FERRAMENTAS = 'Read,Grep,Glob,WebSearch,WebFetch';
    // No Windows o `python3` costuma ser o atalho da Microsoft Store, que abre a loja em vez de rodar.
    static PYTHON = process.platform === 'win32' ? 'python' : 'python3';

    constructor({ workspace = WORKSPACE, casa = homedir() } = {}) {
        this.workspace = workspace;
        this.casa = casa;
    }

    skill() {
        return [join(this.workspace, '.claude/skills/the-judge'), join(this.casa, '.claude/skills/the-judge')]
            .find(d => existsSync(join(d, 'SKILL.md'))) || null;
    }

    base() {
        return join(caminhoEstado(), 'corridas', 'juiz');
    }

    // A forma da linha de comando é a garantia de "só leitura": por isso é pública e tem teste.
    argumentos({ prompt, skill, dir, modelo, sessao }) {
        return [
            '-p', prompt,
            ...(sessao ? ['--resume', sessao] : []),
            '--restricted', '--tools', Juiz.FERRAMENTAS, '--strict-mcp-config', '--permission-prompts', 'none',
            // Sem isto a pesquisa do passo 2 é negada: web pede aprovação, e aqui ninguém aprova.
            '--allowedTools', 'WebSearch', 'WebFetch',
            '--add-dir', skill, '--add-dir', dir,
            ...(modelo ? ['--model', modelo] : []),
            '--effort', 'high', '--output-format', 'stream-json', '--verbose', '--max-turns', '80'
        ];
    }

    // O último bloco ```json da resposta; sem bloco, o trecho entre a primeira { e a última }.
    extrairJson(texto) {
        const blocos = [...String(texto || '').matchAll(/```json\s*\n([\s\S]*?)```/g)];
        const candidato = blocos.length
            ? blocos[blocos.length - 1][1]
            : String(texto || '').slice(String(texto).indexOf('{'), String(texto).lastIndexOf('}') + 1);
        try {
            const dado = JSON.parse(candidato);
            return dado && typeof dado === 'object' && !Array.isArray(dado) ? dado : null;
        } catch {
            return null;
        }
    }

    async preparar(projeto, chamado) {
        const skill = this.skill();
        if (!skill) {
            return { erro: 'a skill the-judge não está instalada' };
        }
        const raiz = join(this.workspace, projeto);
        const numero = await this._prDoChamado(raiz, chamado);
        if (!numero) {
            return { erro: `nenhuma PR com a branch ${chamado} em ${projeto}` };
        }
        const pr = JSON.parse(await this._cmd('gh', ['pr', 'view', String(numero), '--json',
            'number,title,body,author,url,state,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles,files'], raiz));
        const dir = join(this.base(), `${chamado}__${projeto}__${new Date().toISOString().replace(/[:.]/g, '-')}`);
        mkdirSync(join(dir, 'pr'), { recursive: true });
        const diff = await this._cmd('gh', ['pr', 'diff', String(numero)], raiz);
        writeFileSync(join(dir, 'pr.diff'), diff);
        const login = (await this._cmd('gh', ['api', 'user', '--jq', '.login'], raiz)).trim();
        const revisoes = JSON.parse(await this._cmd('gh', ['api', `repos/{owner}/{repo}/pulls/${numero}/reviews`], raiz) || '[]')
            .filter(r => r.user?.login === login);
        const varredura = await this._comEntrada(Juiz.PYTHON, [join(skill, 'scripts/scan_bypasses.py')], diff);
        const arquivos = await this._copiarHead(raiz, pr, dir);
        const lintado = await this._lint(projeto, raiz, pr, arquivos);
        const ctx = { projeto, chamado, raiz, skill, dir, pr, login, revisoes, varredura, arquivos, lintado };
        writeFileSync(join(dir, 'contexto.json'), JSON.stringify({ ...ctx, pr: { ...pr, body: undefined } }, null, 2));
        return ctx;
    }

    prompt(ctx) {
        return `Você é o the-judge. Antes de tudo, leia ${ctx.skill}/SKILL.md e, quando ela mandar, references/review-standards.md e references/comment-voice.md da mesma pasta. Revise em português do Brasil, com acentos.

Esta corrida é SÓ LEITURA por desenho: você não tem Bash, não escreve arquivo e não tem conectores. O que a skill faz com comando já foi feito pela tela:
- Passo 0 (contexto) e Passo 1 (checagens determinísticas e varredura de bypasses): prontos abaixo. Não tente rodar nada.
- Passo 6 (o portão review_gate.py): a tela roda sobre o JSON que você devolver e manda as violações de volta, se houver.
- Passo 7 (publicar): NÃO existe nesta corrida. Nada vai para o GitHub.
Faça os passos 2 (pesquisa obrigatória, com WebSearch/WebFetch), 3, 4 e 5.

Código: a versão da HEAD da PR de cada arquivo alterado está em ${ctx.dir}/pr/<caminho>, e o diff completo em ${ctx.dir}/pr.diff. O repo em ${ctx.raiz} pode estar em OUTRA branch: use-o só para chamadores e chamados. Ao citar path:line, use o caminho do repo (sem o prefixo da cópia) e a linha da cópia da head.

A sua ÚLTIMA mensagem deve ser só o findings.json do passo 5, num bloco \`\`\`json.

${this.inventario(ctx)}`;
    }

    inventario(ctx) {
        const { pr, revisoes, arquivos, lintado, varredura } = ctx;
        const ultima = revisoes[revisoes.length - 1];
        return [
            `## PR #${pr.number} — ${pr.title}`,
            `${pr.url} · estado ${pr.state} · autor ${pr.author?.login || '?'} · você no gh: ${ctx.login || '?'}`,
            `base ${pr.baseRefName} ← head ${pr.headRefName} @ ${pr.headRefOid}`,
            `+${pr.additions} -${pr.deletions} em ${pr.changedFiles} arquivo(s)`,
            '',
            '## Descrição da PR',
            pr.body?.trim() || '(vazia)',
            '',
            '## Arquivos (cópia da head em pr/)',
            ...arquivos.map(a => `- ${a.caminho} (+${a.adicionadas} -${a.removidas})${a.removido ? ' — removido na head' : ''}${a.grande ? ' — grande demais, só pelo diff' : ''}`),
            '',
            '## Rodada',
            ultima
                ? `${revisoes.length + 1} — sua última revisão nesta PR (${ultima.submitted_at}):\n${ultima.body || '(sem corpo)'}`
                : '1 — nenhuma revisão sua nesta PR',
            '',
            '## Passo 1 — checagens determinísticas',
            `Lint: ${lintado}`,
            'Testes: NÃO rodados — a tela não roda a suíte de teste do repo (o npm test do migrate-mongo apaga o banco local). Diga isso em "Checks run".',
            `Varredura de bypasses (scan_bypasses.py, já rodada sobre o diff): ${varredura.trim() || 'nenhum candidato'}`
        ].join('\n');
    }

    async julgar(ctx, { modelo, aoEvento = () => {}, tentativas = 3 }) {
        const inicio = Date.now();
        const eventos = [];
        let sessao = null;
        let findings = null;
        let gate = null;
        let prompt = this.prompt(ctx);
        let erro = null;
        let tentativa = 0;
        while (tentativa < tentativas) {
            tentativa++;
            const r = await this._rodar(this.argumentos({ prompt, skill: ctx.skill, dir: ctx.dir, modelo, sessao }), ctx.raiz, ev => {
                eventos.push(ev);
                aoEvento(ev);
            });
            sessao = r.sessao || sessao;
            if (r.codigo !== 0 && !r.resultado) {
                erro = r.erro || `o claude saiu com código ${r.codigo}`;
                break;
            }
            findings = this.extrairJson(r.resultado);
            if (!findings) {
                erro = 'o juiz não devolveu um findings.json legível';
                break;
            }
            writeFileSync(join(ctx.dir, 'findings.json'), JSON.stringify(findings, null, 2));
            gate = await this._portao(ctx.skill, ctx.dir);
            if (gate.ok || !sessao) {
                break;
            }
            aoEvento({ texto: `o portão da skill reprovou — devolvendo as violações ao juiz (tentativa ${tentativa + 1})` });
            prompt = `O portão (review_gate.py) reprovou o seu findings.json:\n\n${gate.saida}\n\nCorrija cada violação e devolva o findings.json completo de novo, só ele, num bloco \`\`\`json.`;
        }
        const resultado = {
            chamado: ctx.chamado, projeto: ctx.projeto, dir: ctx.dir,
            pr: { numero: ctx.pr.number, url: ctx.pr.url, titulo: ctx.pr.title, base: ctx.pr.baseRefName, head: ctx.pr.headRefName, estado: ctx.pr.state },
            inicio: new Date(inicio).toISOString(), fim: new Date().toISOString(),
            segundos: Math.round((Date.now() - inicio) / 1000),
            ok: Boolean(findings) && !erro, erro, findings,
            gate: gate ? { ...gate, tentativas: tentativa } : null,
            modelo: modelo || 'padrão do CLI',
            eventos: eventos.slice(-300)
        };
        writeFileSync(join(ctx.dir, 'resultado.json'), JSON.stringify(resultado, null, 2));
        return resultado;
    }

    ultimo(chamado, projeto) {
        const prefixo = `${chamado}__${projeto}__`;
        let pastas = [];
        try {
            pastas = readdirSync(this.base()).filter(n => n.startsWith(prefixo)).sort().reverse();
        } catch {
            return null;
        }
        for (const p of pastas) {
            try {
                return JSON.parse(readFileSync(join(this.base(), p, 'resultado.json'), 'utf8'));
            } catch {
                continue;
            }
        }
        return null;
    }

    // Aberta primeiro; sem aberta, a mais recente. Branch com sufixo (`UND-1-hml`) é outra PR, de propósito.
    async _prDoChamado(raiz, chamado) {
        const lista = JSON.parse(await this._cmd('gh', ['pr', 'list', '--head', chamado, '--state', 'all',
            '--json', 'number,state,updatedAt', '--limit', '10'], raiz) || '[]');
        const ordenada = lista.sort((a, b) => (a.state === 'OPEN') - (b.state === 'OPEN') || a.updatedAt.localeCompare(b.updatedAt)).reverse();
        return ordenada[0]?.number || null;
    }

    // A head pode não estar no clone (PR de outra pessoa, branch nunca baixada): o fetch traz só o
    // objeto, para o FETCH_HEAD — nenhuma branch local é criada nem mexida.
    async _copiarHead(raiz, pr, dir) {
        const tem = async () => (await this._cmd('git', ['cat-file', '-e', `${pr.headRefOid}^{commit}`], raiz, true)) !== null;
        if (!await tem()) {
            await this._cmd('git', ['fetch', '--quiet', '--no-tags', 'origin', `pull/${pr.number}/head`], raiz, true);
        }
        const disponivel = await tem();
        const saida = [];
        for (const f of pr.files || []) {
            const item = { caminho: f.path, adicionadas: f.additions, removidas: f.deletions };
            if (!disponivel) {
                saida.push({ ...item, grande: true });
                continue;
            }
            try {
                const { stdout } = await execFileAsync('git', ['-C', raiz, 'show', `${pr.headRefOid}:${f.path}`],
                    { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 });
                const alvo = join(dir, 'pr', f.path);
                mkdirSync(dirname(alvo), { recursive: true });
                writeFileSync(alvo, stdout);
                saida.push(item);
            } catch (e) {
                saida.push({ ...item, ...(e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? { grande: true } : { removido: true }) });
            }
        }
        return saida;
    }

    // O linter roda na árvore de trabalho: fora da head da PR ele julgaria outro código.
    async _lint(projeto, raiz, pr, arquivos) {
        const head = (await this._cmd('git', ['rev-parse', 'HEAD'], raiz, true) || '').trim();
        if (head !== pr.headRefOid) {
            const branch = (await this._cmd('git', ['rev-parse', '--abbrev-ref', 'HEAD'], raiz, true) || '?').trim();
            return `não rodado — o checkout de ${projeto} está em ${branch} @ ${head.slice(0, 8)}, não na head da PR`;
        }
        const r = await lint.rodar(projeto, arquivos.filter(a => !a.removido).map(a => a.caminho));
        if (r.nota) {
            return r.nota;
        }
        const falhas = (r.falhas || []).map(f => `${f.nome} falhou: ${f.motivo}`);
        const achados = r.achados.map(a => `  ${a.arquivo}:${a.linha} ${a.regra || ''} ${a.mensagem || ''}`.trimEnd());
        return [`${r.linters.join(', ')} — ${r.total || 0} achado(s)`, ...falhas, ...achados].join('\n');
    }

    async _portao(skill, dir) {
        try {
            const { stdout, stderr } = await execFileAsync(Juiz.PYTHON, [join(skill, 'scripts/review_gate.py'), join(dir, 'findings.json')], { encoding: 'utf8' });
            return { ok: true, saida: `${stdout}${stderr}`.trim() };
        } catch (e) {
            return { ok: false, saida: `${e.stdout || ''}${e.stderr || ''}`.trim() || e.message };
        }
    }

    _rodar(args, cwd, aoEvento) {
        return new Promise(resolver => {
            // O hook do workspace lê isto para não injetar a rotina de fim numa corrida fechada.
            const filho = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, QUALIDADE_AGENTE: 'juiz' } });
            let resto = '';
            let erro = '';
            let resultado = null;
            let sessao = null;
            filho.stdout.on('data', pedaco => {
                resto += pedaco.toString();
                const linhas = resto.split('\n');
                resto = linhas.pop() || '';
                for (const linha of linhas) {
                    let e;
                    try {
                        e = JSON.parse(linha);
                    } catch {
                        continue;
                    }
                    sessao = e.session_id || sessao;
                    if (e.type === 'result') {
                        resultado = String(e.result || '');
                    }
                    const ev = this._traduzir(e);
                    if (ev) {
                        aoEvento({ em: new Date().toISOString(), ...ev });
                    }
                }
            });
            filho.stderr.on('data', p => { erro += p.toString().slice(0, 2000); });
            filho.on('error', e => resolver({ codigo: -1, erro: `não consegui rodar o claude: ${e.message}` }));
            filho.on('close', codigo => resolver({ codigo, resultado, sessao, erro: erro.trim().split('\n')[0] || null }));
        });
    }

    _traduzir(e) {
        if (e.type === 'assistant') {
            for (const parte of e.message?.content || []) {
                if (parte.type === 'tool_use') {
                    const alvo = parte.input?.file_path || parte.input?.pattern || parte.input?.query || parte.input?.url || '';
                    return { ferramenta: parte.name, texto: String(alvo).slice(0, 400) };
                }
                if (parte.type === 'text' && parte.text.trim()) {
                    return { texto: parte.text.trim().slice(0, 600) };
                }
            }
        }
        if (e.type === 'system' && e.subtype === 'init') {
            return { texto: 'sessão do juiz iniciada' };
        }
        return null;
    }

    async _cmd(exec, args, cwd, silencioso = false) {
        try {
            const { stdout } = await execFileAsync(exec, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
            return stdout;
        } catch (e) {
            if (silencioso) {
                return null;
            }
            throw new Error(`${exec} ${args.slice(0, 3).join(' ')}: ${`${e.stderr || e.message}`.trim().split('\n')[0]}`);
        }
    }

    _comEntrada(exec, args, entrada) {
        return new Promise(resolver => {
            const filho = spawn(exec, args, { stdio: ['pipe', 'pipe', 'ignore'] });
            let saida = '';
            filho.stdout.on('data', p => { saida += p.toString(); });
            filho.on('error', () => resolver('(varredura indisponível: python3 não rodou)'));
            filho.on('close', () => resolver(saida));
            filho.stdin.end(entrada);
        });
    }
}

export default new Juiz();

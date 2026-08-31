# quality-gate

Tela local para conferir a qualidade de uma tarefa antes de abrir a PR: os checks em cima, o diff
antes/depois embaixo. Mais as ferramentas de linha de comando que ela usa.

**Instalação: [`instalacao/README.md`](instalacao/README.md)** — e `node instalacao/verificar.mjs`
diz o que falta antes de você tentar.

Sem dependência e sem `npm install`. Só o Node do sistema (20.11+).

---

## O problema que ele resolve

Num workspace com muitos repos independentes, um chamado toca vários deles. Os erros que doem não
aparecem no code review — aparecem semanas depois:

- o **repo esquecido**: tem a branch do chamado, ficou sem PR, e ninguém viu
- o **build pulado**: o check aparece como `SKIPPED` e a ausência de falha é lida como sucesso
- a **query nova sem índice**: passa em todo teste e só dói com volume de produção
- a **regra do time** que ninguém checa porque está num documento

## A regra que organiza tudo

**O que é mecânico se corrige. O que exige julgamento se confere.**

Item mecânico não merece um cartão na tela nem uma pergunta — merece um commit. Por isso a tela
mostra menos do que ela sabe: comentário fora do padrão, declaração solta, arquivo na pasta errada e
literal onde cabe enum saem da tela e vão para `checar-diff.mjs --corrigir`.

## As duas seções da barra

**Chamados** — os chamados abertos, ordenados pelo commit mais recente.

A descoberta é pelas branches que **existem** (locais e do origin), não pela que está em checkout:
repo com a branch do chamado mas parado em outro trabalho é justamente o repo esquecido. Num chamado
real, **7 repos tinham a branch e só 5 estavam nela** — os outros dois não apareciam.

Um chamado só entra na lista se **algum repo está parado nele**. Sem esse corte vinham quase 200
chamados, quase todos branch antiga nunca apagada — e aí o repo esquecido some no ruído.

Cada linha traz o pino com o pior estado da conferência daquele repo, a branch em checkout (âmbar
quando difere da do chamado) e `N ✎` para arquivos alterados e não commitados. Abaixo dos repos, os
**links das PRs**, que abrem em aba nova.

**Configurações** — os markdown que governam as rotinas, editáveis na tela. É markdown cru de
propósito: o arquivo **é** a instrução que o agente lê, e um formulário só saberia representar os
campos que alguém previu. `Cmd+S` salva, cada salvamento grava um `.bak`, conteúdo vazio é recusado,
e o caminho vem de uma **allowlist por chave** no servidor — nunca do cliente.

## Subir a tela

```bash
npm start          # http://localhost:4100
PORT=4200 npm start
```

O diff é montado a cada requisição — não existe arquivo temporário para envelhecer. Duas coisas
garantem que abrir um arquivo não trave a aba:

- **conteúdo por arquivo**, só quando você abre aquele arquivo
- **regiões sem alteração dobradas**, com 6 linhas de contexto e um `⋯ N linhas sem alteração`.
  Um lockfile com 4 linhas alteradas em 9.648: sem a dobra são **1,5 MB e ~58 mil nós no DOM**, e a
  aba congela. Com a dobra são **4,8 KB e 62 linhas, em 90 ms**. O link **ver arquivo inteiro**
  carrega tudo quando você quiser.

## O que a tela mostra, e o que ela deliberadamente não mostra

**Fora da tela**, porque são corrigidos: comentário acima de `class`, comentário dentro do
`definition` de um model, comentário em migration, `console.log` em migration, bloco de comentário
longo, literal onde cabe enum, arquivo fora da pasta convencional, declaração solta no topo, e a
anotação da PR no chamado.

**Fora da tela** por outro motivo: o **build**, que só roda depois da PR aceita — conferir build
antes do merge não responde nada.

**Na tela**, em 5 abas, só o que exige alguém decidindo:

| Aba | O que julgar |
|---|---|
| Chamado | branch no padrão do ID, arquivos não commitados |
| Testes e lint | spec novo é permitido neste repo? o teste quebra se você reverter a correção? · **e o linter do próprio projeto** |
| Dados e performance | as queries que entraram no diff, com o padrão de risco de cada uma |
| Refatoração | métodos longos novos, blocos repetidos, nomes que já existem no repo |
| Pontos de atenção da IA | o que o agente achou e vale registrar — teto de 10 |

Cada aba tem um pino com o **pior estado do grupo**, para dizer se vale abrir antes de você abrir.
Ao lado do título fica o selo da PR: **sem PR / PR aberta / mesclada** (clicável).

### Nada aqui é regex

`lib/ast.mjs` lê o código por **AST** (`vendor/acorn.mjs`, arquivo único, MIT). Duas regras deste
projeto já acusaram o jeito **certo** por olharem uma linha um problema que vive em várias —
comentário acima de `class`, e filtro Mongo multilinha, que é a forma normal de escrever. Com AST,
"esse `find` tem filtro vazio?" deixa de ser heurística e vira `arg.properties.length === 0`.

Custo: **6 ms para 179 linhas**. Arquivo que não parseia (outra linguagem, sintaxe futura) devolve
`null` e o cartão diz que não leu, em vez de inventar achado.

**Bloco de declaração é reconhecido pela forma, não por lista de pastas** — três formas: campos no
`this` (uma classe de constantes com 210 sentenças), tabela de registro (`this.acoes.set(...)`
repetido dezenas de vezes) e um literal de dados dominando o corpo (`this.def = { ... }`). Antes era
uma regex de caminhos, e a classe de constantes escapava dela por não morar em `enums/`.

### O linter é o do projeto, não um meu

`lib/lint.mjs` roda o linter que **cada repo** configurou, só nos arquivos do diff:

| Ferramenta | Quando é usada | Custo medido |
|---|---|---|
| `eslint -f json` | repo com `eslint.config.mjs` | **681 ms** para 15 arquivos |
| `ruff check --output-format=json` | repo com `.venv/bin/ruff` | **188 ms** para 25 arquivos |

Os limites (`complexity`, `max-depth`, `cognitive-complexity`) são os que quem mantém o repo
calibrou — melhor que qualquer número fixo escolhido aqui. No repo inteiro, um projeto grande acusava
83 problemas de código que ninguém tocou; no escopo do diff, o que aparece é seu. Projeto sem linter
configurado diz **"nenhum linter configurado"** em vez de fingir que passou.

### As duas análises que leem o diff

- **queries**: acha as chamadas ao banco no AST e marca filtro vazio, campo aninhado, regex sem
  âncora `^`, operador negativo, `updateMany`/`deleteMany` sem campo de recorte, e `sort` sem `limit`
  (pela cadeia de chamadas, não pelo texto da linha). Distingue `.find({...})` do driver de
  `.find(x => ...)` de array pelo **tipo do nó** do primeiro argumento. 10 casos certo/errado
  calibrados
- **refatoração**: método novo com mais de 40 linhas pelo **span do nó**, corrida de 4+ linhas
  idênticas repetida no diff, e nome de método novo que já aparece em outro arquivo (`git grep`, não
  memória)

## Pontos de atenção da IA

Ficam em `pontos-atencao.json` — arquivo, não banco. São no máximo 10 registros: assim ficam
legíveis, editáveis à mão, greppáveis e versionáveis.

Cada ponto tem `chamado` e `projeto` — nulo significa "vale para o workspace". A aba mostra só os que
casam com o que está na tela.

```bash
node ferramentas/pontos.mjs listar
node ferramentas/pontos.mjs add <id> <atencao|aviso|nota> <titulo> <detalhe> [chamado] [projeto]
node ferramentas/pontos.mjs remover <id>
```

O teto de 10 descarta o mais antigo quando entra o 11º. É o freio: ponto novo só entra empurrando um
velho, então a lista não vira despejo. O `×` no cartão tira um ponto direto da tela, e a remoção fica
registrada no `gate.log`.

Comece de `pontos-atencao.example.json`.

## Realce de sintaxe

`web/realce.js` — tokenizador próprio de ~150 linhas cobrindo JS/TS, Python, Java, JSON, HTML/XML,
CSS, YAML, SQL e shell, escolhido pela extensão do arquivo. Sem CDN (quebraria offline) e sem
vendorizar um highlighter inteiro (100 KB para realçar 40 linhas por vez).

O estado atravessa as linhas, porque `/* */` e docstring de Python não cabem numa linha só — e
**zera na lacuna**: errar limitado é melhor que pintar o resto do arquivo como comentário.

## Cache e recarregamento

O resultado é cacheado no servidor (TTL de 5 min, 30 s para a lista de chamados). Três formas de
atualizar:

- botão **recarregar** — invalida o cache do projeto e relê
- **sozinho**, quando o hook de `PostToolUse` vê um `git commit`/`merge`/`rebase`/`checkout`/`reset`:
  chama `/api/invalidar` e a tela aberta recebe o aviso por SSE, mostra um toast e relê
- o TTL, que é só a rede de segurança

O carimbo ao lado do botão diz se o que está na tela foi **lido agora** ou veio **do cache de** que
horas.

> Mudança em `lib/` exige **reiniciar o servidor**: invalidar o cache não recarrega módulo ES já em
> memória.

## Ferramentas

| Script | Para que serve |
|---|---|
| `ferramentas/contexto.mjs [ID] [--json]` | Estado do chamado atravessando os repos: branch, PR, base observada, checks |
| `ferramentas/checar-diff.mjs <projeto> [base\|--staged] [--ref=<branch>] [--corrigir] [--json]` | As 9 checagens. `--corrigir` apaga as mecânicas; `--autoteste` valida as regras |
| `ferramentas/diff-visao.mjs <projeto> [base] [dir]` | HTML estático, para quando não quiser subir a tela |
| `ferramentas/indices.mjs <colecao> '<filtro>'` | Índices, plano de execução e tipo real dos campos no banco de stage |
| `ferramentas/pontos.mjs` | Pontos de atenção |

Repo parado em outro checkout precisa do `--ref=<branch>` — sem ele a checagem olha o trabalho
errado.

Sob o capô, tudo é **uma chamada em vez de N**: `--numstat` para todos os arquivos de uma vez
(206 → 65 ms), um `git diff -U0` único (220 → 84 ms), um `git grep` com todos os nomes (79 → 28 ms),
leitura de disco em vez de `git show` por arquivo (139 → 1 ms), e as PRs em paralelo
(**17,1 s → 0,7 s**).

## Antes de usar o `indices.mjs`

```bash
cp .env.example .env
```

Leia os comentários do `.env.example`: ele explica quais chaves têm efeito **naquele arquivo** e
quais são do processo. Resumo da armadilha: `PORT` no `.env` **não faz nada**.

Precisa de um usuário de banco com permissão só de leitura. Não reaproveitar usuário de escrita: o
guard do `lib/stg.mjs` é client-side — bloqueia `insert`/`update`/`delete`/`$out`/`$merge`, recusa
host que pareça produção e conecta com `secondaryPreferred` — mas isso protege o script, não o
cluster.

## O hook

Registrado no `settings.json` do Claude Code, **não bloqueia nada**:

| Evento | Gatilho | O que faz |
|---|---|---|
| `UserPromptSubmit` | prompt fala de commit/push/PR/merge/finalizar | injeta a **rotina de fim inteira** no contexto do agente |
| `PreToolUse` (Bash) | `git commit` ou `gh pr create` | se a tela está no ar, devolve o link; senão gera HTML temporário |
| `PostToolUse` (Bash) | `git commit`, `merge`, `rebase`, `checkout`, `reset` | derruba o cache; a tela recarrega sozinha |

Injeta o **conteúdo** do markdown, não o caminho: caminho ainda dependeria de decidir abrir. Uma vez
por dia por chamado. Falha aberto sempre — **29 ms** de overhead em comando que não casa.

Por que existe: memória que exige *decidir consultar* não é consultada. Isso foi medido três vezes
antes deste projeto, uma delas com **0 buscas em 5.693 chamadas de ferramenta**.

## Convenções assumidas, e cegueiras conhecidas

Sem estas o projeto abre vazio, e nenhuma é configurável hoje:

- **branch = ID do chamado em maiúsculo**, no padrão `ABC-1234`. Branch `feat/...` nunca aparece
- um chamado é aberto quando **algum repo está com aquela branch em checkout**
- os repos são clones locais **irmãos** deste projeto

E duas cegueiras: a varredura só vê **clones locais**, e **não faz `git fetch`** — então `origin/*`
pode estar semanas atrasado. Toda afirmação de ausência aqui é sobre o disco, não sobre o remoto.

## Regra para mexer nas checagens

Uma checagem só entra depois de um erro que aconteceu de verdade, e só com **exemplo do jeito certo
e do errado** em `autoteste()`, os dois passando:

```bash
node ferramentas/checar-diff.mjs --autoteste     # 13 casos
```

Checagem que acusa o jeito certo ensina a ignorar o aviso — e aí o conjunto inteiro morre. Isso já
foi exercido aqui quatro vezes:

- `comentario-bloco-longo` nasceu errada, filtrando por número de linha em vez de "antes dos
  imports". O autoteste pegou
- a de spec novo começou como **erro** e acusou arquivos já aprovados — virou aviso que **conta
  quantos irmãos têm spec**, porque foi esse número que mudou a decisão
- o filtro Mongo lia só o resto da linha e dava "filtro vazio" em filtro bem recortado. Virou AST
- "método longo" acusava construtor de classe de constantes. Virou reconhecimento por forma

Escape para decisão já tomada: `// qualidade:ok <nome-da-regra>` na linha, na anterior, ou nas 5
primeiras do arquivo.

## O que dá para acrescentar depois

Nada disso deve ser escrito antes de doer:

- **`ripple.mjs`** — o de-para que hoje é lembrança: rota nova → arquivo de rotas do gateway; chave
  nova → migrate de tradução; ação nova na tela → classe de permissão em cada visão; role nova →
  aviso de criar no provedor de identidade em staging **e** produção
- **`equivalencia.mjs`** — roda a consulta antes e depois de uma refatoração e compara a saída.
  Refatoração que muda o resultado deixa de ser invisível
- **`filas.mjs`** — dado o nome de uma fila, quem produz e quem consome

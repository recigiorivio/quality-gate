# quality-gate

**Instalação: [`instalacao/README.md`](instalacao/README.md)** — e
`node instalacao/verificar.mjs` diz o que falta antes de você tentar.

Tela local para conferir a qualidade de uma tarefa: os checks em cima, o diff antes/depois embaixo.
Mais as ferramentas de linha de comando que a tela usa.

Sem dependência e sem `npm install` — só o Node do sistema (v22). O driver do Mongo é reaproveitado
de `workflow-admin/server/node_modules`.

## As duas seções da barra

**Chamados** — os chamados abertos no workspace, ordenados pelo commit mais recente.

A descoberta é pelas branches que **existem** (locais e do origin), não pela que está em checkout:
repo com a branch do chamado mas parado em outro trabalho é justamente o repo esquecido. Medido no
UND-1638: **7 repos têm a branch, 5 estavam nela** — `contas-service` e `drmarvin-core-js` não
apareciam. Repo fora do checkout leva a etiqueta `fora`, e o diff dele compara **o ref da branch do
chamado**, não o HEAD (senão mostraria o diff do trabalho errado).

Um chamado só entra na lista se **alguém está parado nele** em algum repo. Sem esse corte vinham 190
chamados, quase todos branch antiga nunca apagada — e aí o repo esquecido some no ruído.

**Duas cegueiras conhecidas:** a varredura só vê **clones locais**, e **não faz `git fetch`** — então
`origin/*` pode estar semanas atrasado. E branch fora do padrão `XXX-0000` nunca aparece: o `argocd`
usa `feat/*`, então trabalho de gitops não é visto por aqui. Cada repo tem um pino com o pior estado da
conferência dele, e o badge `N ✎` conta arquivos alterados e não commitados (coisas diferentes).

**Configurações** — os markdown que governam as rotinas, editáveis na tela:

| | Arquivo |
|---|---|
| Rotina de início | `.claude/commands/inicio-trabalho.md` |
| Rotina de fim | `.claude/commands/final-trabalho.md` |
| Regras de código | `.claude/docs/qualidade-de-codigo.md` |

É markdown cru de propósito: o arquivo **é** a instrução que eu leio, e um formulário só saberia
representar os campos que alguém previu. `Cmd+S` salva. Cada salvamento grava um `.bak` ao lado antes
de sobrescrever, conteúdo vazio é recusado, e o caminho vem de uma **allowlist por chave** no servidor
— nunca do cliente.

Para acrescentar um item de qualidade a ser feito antes ou depois: editar a rotina correspondente
aqui. A de fim é injetada no meu contexto automaticamente quando você fala de commit, PR ou merge, e
por isso o que você escrever nela me alcança sem depender de eu lembrar de abrir o arquivo.

## Subir a tela

```bash
cd qualidade && npm start        # http://localhost:4100
```

A esquerda lista os **chamados** abertos no workspace (branch no padrão do ID), agrupados por
chamado e ordenados pelo commit mais recente — é assim que o repo esquecido aparece. Clicar num repo
monta a conferência.

O diff é montado a cada requisição — não existe arquivo temporário para envelhecer.

Duas coisas garantem que abrir um arquivo não trave a aba:

- **conteúdo por arquivo**, só quando você abre aquele arquivo (o diff inteiro do UND-1638 são 2,4 MB)
- **regiões sem alteração dobradas**, com 6 linhas de contexto e um `⋯ N linhas sem alteração`.
  O `package-lock.json` do UND-1638 tem 4 linhas alteradas em 9.648: sem a dobra são 1,5 MB e ~58 mil
  nós no DOM, e a aba congela. Com a dobra são 4,8 KB e 62 linhas, em 90 ms. O link
  **ver arquivo inteiro** carrega tudo quando você quiser.

**Tempos medidos** (UND-1638): cartões locais em ~100 ms, os 3 que consultam o `gh`
(branch, PR, build) em ~2,1 s e depois em cache de 60 s. A tela desenha os locais e o diff primeiro,
com os remotos marcados `consultando…` — antes de separar isso, um clique esperava 13 s parado.

## O que a tela mostra, e o que ela deliberadamente não mostra

A regra é a divisão: **o que é mecânico se corrige, o que exige julgamento se confere.** Item
mecânico não merece um cartão — merece um commit.

**Fora da tela**, porque são corrigidos automaticamente (`checar-diff.mjs --corrigir` e a rotina
`/final-trabalho`): comentário acima de `class`, comentário dentro de `const definition = {`,
`console.log` em migration, bloco de comentário longo, literal onde cabe enum, arquivo fora da pasta
convencional, declaração solta no topo, e a anotação da PR no Linear.

**Fora da tela** por outro motivo: o **build**, que só roda depois da PR aceita — conferir build
antes do merge não responde nada.

**Na tela**, em 4 abas, só o que exige alguém decidindo:

| Aba | O que julgar |
|---|---|
| Chamado | branch no padrão do ID, arquivos não commitados |
| Testes e lint | spec novo é permitido neste repo? o teste quebra se você reverter a correção? · **e o linter do próprio projeto** |
| Dados e performance | as queries que entraram no diff, com o padrão de risco de cada uma |
| Refatoração | métodos longos novos, blocos repetidos, nomes que já existem no repo |
| Pontos de atenção da IA | o que eu achei e vale registrar — teto de 10, ver abaixo |

### Nada aqui é regex

`lib/ast.mjs` lê o código por **AST** (`vendor/acorn.mjs`, 221 KB, arquivo único, MIT). Duas regras
desta ferramenta já acusaram o jeito **certo** por olharem uma linha um problema que vive em várias —
comentário acima de `class` e filtro Mongo multilinha, que é a forma normal de escrever. Com AST,
"esse `find` tem filtro vazio?" deixa de ser heurística e vira `arg.properties.length === 0`.
Custo: **6 ms** para 179 linhas. Arquivo que não parseia (Python, Java) devolve `null` e o cartão diz
que não leu, em vez de inventar achado.

**Bloco de declaração é reconhecido pela forma, não por lista de pastas** — três formas:
campos no `this` (`Collections.js`, 210 sentenças), tabela de registro (`this.actions.set(...)` × 65
nos loaders) e um literal de dados dominando o corpo (`this.workflow = { tarefas: [...] }`). Antes era
uma regex de caminhos, e o `Collections.js` escapava dela.

### O linter é o do projeto, não um meu

`lib/lint.mjs` roda o linter que **cada repo** configurou, só nos arquivos do diff:

| Ferramenta | Onde | Custo medido |
|---|---|---|
| `eslint -f json` | 11 projetos com `eslint.config.mjs` | **681 ms** para 15 arquivos |
| `.venv/bin/ruff check --output-format=json` | `backend-core-rivio-one`, `alerts-manager-rivio-one` | **188 ms** para 25 arquivos |

Os limites (`complexity`, `max-depth`, `sonarjs/cognitive-complexity`) são os que quem mantém o repo
calibrou — melhor que qualquer número fixo meu. No repo inteiro o `crohc-server` acusa 83 problemas de
código que ninguém tocou; no escopo do diff, o que aparece é seu. Projeto sem linter (Java) diz
"nenhum linter configurado" em vez de fingir que passou.

Esses dois **analisam o diff** (`lib/analise.mjs`), não são checklist:

- **queries**: acha as chamadas Mongo no AST e marca filtro vazio, campo aninhado, regex sem âncora
  `^`, operador negativo, `updateMany`/`deleteMany` sem campo de recorte, e `sort` sem `limit` (pela
  cadeia de chamadas, não pelo texto da linha). Distingue `.find({...})` do Mongo de `.find(x => ...)`
  de array pelo **tipo do nó** do primeiro argumento. 10 casos certo/errado calibrados
- **refatoração**: método novo com mais de 40 linhas pelo **span do nó**, corrida de 4+ linhas
  idênticas repetida no diff, e nome de método novo que já aparece em outro arquivo (`git grep`)

Calibração que já foi necessária, e o motivo importa: construtor longo é **o padrão exigido** em
`enums/`, `loaders/` e `workflows/`, e `execute`/`up`/`down` são nomes do padrão do repo. Acusar
esses três era acusar o jeito certo — e checagem que acusa o jeito certo ensina a ignorar o aviso.

Cada aba tem um pino com o **pior estado do grupo**, para dizer se vale abrir antes de você abrir.
Ao lado do título fica o selo da PR: **sem PR / PR aberta / mergeado** (clicável).

## Pontos de atenção da IA

Ficam em **`pontos-atencao.json`** — arquivo, não banco. São no máximo 10 registros: assim ficam
legíveis, editáveis à mão, greppáveis e versionáveis. O `node:sqlite` do Node 22 é experimental e o
projeto todo é sem dependência; e já havia o precedente do `ocultos.json`.

Cada ponto tem `chamado` e `projeto` — nulo significa "vale para o workspace". A aba mostra só os
que casam com o que está na tela (8 dos 10 no `workflow-manager`, 5 no `migrate-mongo`).

```bash
node ferramentas/pontos.mjs listar
node ferramentas/pontos.mjs add <id> <atencao|aviso|nota> <titulo> <detalhe> [chamado] [projeto]
node ferramentas/pontos.mjs remover <id>
```

O teto de 10 descarta o mais antigo quando entra o 11º. É o freio: ponto novo só entra empurrando um
velho, então a lista não vira despejo. O `×` no cartão tira um ponto direto da tela.

## Realce de sintaxe

`web/realce.js` — tokenizador próprio de ~150 linhas cobrindo JS/TS, Python, Java, JSON, HTML/XML,
CSS, YAML, SQL e shell, escolhido pela extensão do arquivo. Sem CDN (quebraria offline) e sem
vendorizar highlight.js (100 KB para realçar 40 linhas por vez).

O estado atravessa as linhas, porque `/* */` e docstring de Python não cabem numa linha só — e
**zera na lacuna**: errar limitado é melhor que pintar o resto do arquivo como comentário.

## Cache e recarregamento

O resultado é cacheado no servidor (TTL de 5 min, 30 s para a lista de chamados). Três formas de
atualizar:

- botão **recarregar** — invalida o cache do projeto e relê
- **sozinho**, quando o hook de `PostToolUse` vê um `git commit`/`merge`/`rebase`/`checkout`/`reset`:
  ele chama `/api/invalidar` e a tela aberta recebe o aviso por SSE (`/api/eventos`), mostra um toast
  e relê. Sem isso ela mostraria o estado de antes do commit
- o TTL, que é só a rede de segurança

O carimbo ao lado do botão diz se o que está na tela foi **lido agora** ou veio **do cache de** que
horas.

## Ferramentas

| Script | Para que serve |
|---|---|
| `ferramentas/contexto.mjs [ID] [--json]` | Estado do chamado atravessando os 49 repos |
| `ferramentas/checar-diff.mjs <projeto> [base\|--staged] [--json]` | As 8 checagens. `--corrigir` apaga as 3 mecânicas; `--autoteste` valida as regras |
| `ferramentas/diff-visao.mjs <projeto> [base] [dir]` | HTML estático, para quando não quiser subir a tela |
| `ferramentas/indices.mjs <colecao> '<filtro>'` | Índices, plano de execução e tipo real dos campos em stage |
| `lib/diff.mjs` · `lib/workspace.mjs` · `lib/qualidade.mjs` · `lib/stg.mjs` | Compartilhado entre a tela e a linha de comando |

## Antes de usar o `indices.mjs`

```bash
cp .env.example .env      # preencher STG_MONGODB_URI
```

Precisa de um usuário Atlas com role **`read`**. Não reaproveitar usuário de escrita: o guard do
`lib/stg.mjs` é client-side — bloqueia `insert`/`update`/`delete`/`$out`/`$merge`, recusa host que
pareça produção e conecta com `secondaryPreferred` — mas isso protege o script, não o cluster.

**A única connection string Atlas que existe hoje no workspace é de produção**
(`clusterriviooneprd`, em `data/backup-pendenciaCategoria-20260806/`) — é exatamente o atalho que
este `.env` existe para tornar desnecessário.

## O hook

Registrado em `.claude/settings.json`, **não bloqueia nada**:

| Evento | Gatilho | O que faz |
|---|---|---|
| `UserPromptSubmit` | prompt fala de commit/push/PR/merge/finalizar | injeta o `final-trabalho.md` inteiro no contexto do Claude |
| `PreToolUse` (Bash) | `git commit` ou `gh pr create` | se a tela está no ar, devolve o link; senão gera HTML temporário em `$TMPDIR` |

Injeta o **conteúdo** do `.md`, não o caminho: caminho ainda dependeria de decidir abrir.
1×/dia por chamado. Falha aberto sempre — 29 ms de overhead em comando que não casa.

Desligar: apagar a chave `hooks` de `.claude/settings.json`
(backup em `.claude/settings.json.antes-gate`). Log dos disparos em `gate.log`.

## Regra para mexer nas checagens

Uma checagem só entra depois de um erro que aconteceu de verdade, e só com **exemplo do jeito certo
e do errado** em `autoteste()`, os dois passando. Checagem que acusa o jeito certo ensina a ignorar
o aviso.

Já foi exercido aqui duas vezes: a regra `comentario-bloco-longo` nasceu errada (filtrava por número
de linha fixo em vez de "antes dos imports") e o autoteste pegou. E a de spec novo começou como
**erro**, acusando dois arquivos já aprovados em 28/08 — virou aviso que conta quantos irmãos têm
spec, porque foi esse número que mudou a decisão.

Escape para decisão tomada: `// qualidade:ok <nome-da-regra>` na linha, na anterior, ou nas 5
primeiras do arquivo.

## O que dá para acrescentar depois

Nada disso deve ser escrito antes de doer:

- **`ripple.mjs`** — o de-para que hoje é lembrança: rota nova → `routes.json`; chave nova →
  migrate de tradução; ação nova no `tiposSelecao` → `PermissaoAcao` em **cada** mapa de visão;
  role nova → Keycloak staging **e** prod. É a Regra Inviolável inteira, e é toda textual no diff.
- **`equivalencia.mjs`** — roda a consulta antes e depois de uma refatoração contra stage e compara
  a saída. Refatoração que muda o resultado deixa de ser invisível.
- **`filas.mjs`** — dado o nome de uma fila, quem produz e quem consome. Hoje isso é o
  `.claude/docs/rabbitmq-flow-map.md`, que é documento e envelhece.

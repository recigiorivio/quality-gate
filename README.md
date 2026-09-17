<img src="web/favicon.svg" width="72" align="right" alt="">

# quality-gate

Tela local para conferir a qualidade de uma tarefa antes de abrir a PR: os checks em cima, o diff
antes/depois embaixo. Mais as ferramentas de linha de comando que ela usa.

**Instalação: [`instalacao/README.md`](instalacao/README.md)** — e `node instalacao/verificar.mjs`
diz o que falta antes de você tentar.

Sem dependência e sem `npm install` — continua valendo, e o `package.json` não tem `dependencies`.

**Mas o piso do Node subiu para 22.5.0** (`engines.node`), e vale explicar por quê para ninguém
perder uma tarde: o estado que dois processos escrevem passou de JSON para um SQLite, e o SQLite vem
do módulo **embutido** `node:sqlite`, que só existe a partir do Node 22.5.0. Ou seja: nenhum pacote
novo entrou, só um módulo do próprio Node que é novo demais para o piso antigo (20.11).

Em Node 20 nada avisa antes. O `npm install` não existe aqui para reclamar do `engines`, o
`instalacao/verificar.mjs` **ainda cobra só 20.11 e deixa passar** (é o próximo conserto), a tela
sobe, e a quebra chega no primeiro acesso ao banco como `ERR_UNKNOWN_BUILTIN_MODULE` em
`node:sqlite` — um erro que fala de módulo inexistente, não de versão velha. Se você viu isso, é a
versão do Node:

```bash
node -v                # precisa ser >= 22.5.0
```

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

## As três zonas da tela

**Barra da esquerda — só navegação.** Uma linha por chamado: o ID, o título do chamado como
subtítulo (sem ele, `UND-1638` não diz nada), o pino com o pior estado, quantos repos, e um `×` para
tirar da lista. Antes ela fazia três trabalhos em 340 px — navegar, resumir e detalhar — e nenhum
refinamento resolvia isso.

Ela tem **três abas** e um pé:

```
┌──────────┬────────────┬──────────────┐
│ CHAMADOS │ IMPLANTAÇÃO│ CONFIGURAÇÕES│   ← as três visões, exclusivas
└──────────┴────────────┴──────────────┘
   (o painel da aba ativa)
──────────────────────────────────────
 ● 3 agentes abertos                ›    ← o pé: estado, vale nas três
```

As três já eram exclusivas — `trocarVisao()` esvazia as outras — mas eram expressas de três jeitos:
duas sanfonas e um botão de rodapé. Abrir uma sanfona fechava a outra, o que é justamente o que uma
sanfona **não** promete. A aba diz a verdade de cara.

**O pé é o que não é visão.** Estado da máquina não pertence a nenhuma delas: enquanto o contador de
agentes morava dentro de Chamados, ele sumia na Implantação e nas Configurações — exatamente quando
saber que há agente rodando mais importa.

**Centro — o veredito e o diff.** Uma linha de contagens, os cartões recolhidos, e o diff abaixo.

**Trilha da direita, recolhível — o detalhe do chamado.** Na ordem: chamado (com o link do Linear),
branches, **todas** as PRs, e `recarregar` no fim.

Os chamados são ordenados pelo commit mais recente.

A descoberta é pelas branches que **existem** (locais e do origin), não pela que está em checkout:
repo com a branch do chamado mas parado em outro trabalho é justamente o repo esquecido. Num chamado
real, **7 repos tinham a branch e só 5 estavam nela** — os outros dois não apareciam.

Um chamado só entra na lista se **algum repo está parado nele**. Sem esse corte vinham quase 200
chamados, quase todos branch antiga nunca apagada — e aí o repo esquecido some no ruído.

Cada linha traz o pino com o pior estado da conferência daquele repo, a branch em checkout (âmbar
quando difere da do chamado) e `N ✎` para arquivos alterados e não commitados. Abaixo dos repos, os
**links das PRs**, que abrem em aba nova.

As PRs vêm de **duas fontes**, porque uma sozinha mente:

| Fonte | Acha | Perde |
|---|---|---|
| branch local | PR do repo clonado cuja branch é exatamente o ID | repo não clonado, e branch com sufixo |
| busca na organização | o resto, pelo ID no título | nada — mas casa o número do PR, então filtra por palavra |

Medido num chamado real: a varredura local achava 7 PRs e **perdia 3** — um em repo que não está
clonado aqui (o de gitops) e dois em branch com sufixo (`UND-1638-envelope`, `UND-1638-hml`). Os que
só a busca encontra levam `◇` e uma borda âmbar.

O dedup é pela **URL do PR**. Nome de pasta não serve (os forks renomearam o remote) e nome do remote
também não: um repo local aponta para o fork, mas o `gh` resolve o PR no repo **pai**, então as duas
chaves discordavam e o mesmo PR aparecia duas vezes.

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

### Expor na rede — opt-in, e nunca sem token

Por padrão a tela escuta só em `127.0.0.1`: de outra máquina a conexão é recusada. Para abrir no seu
IP:

```bash
QUALIDADE_HOST=0.0.0.0 npm start
# qualidade → http://192.168.10.129:4100/?t=9f54324dbcb7e9511660cbc72df93227
# ⚠  exposto na rede, token sorteado agora — /api/agente executa comando nesta máquina.
```

**O localhost nunca precisa de token.** Ele existe para a rede; exigi-lo de `127.0.0.1` só quebrava
o `http://localhost:4100/` de sempre. Quem já está na máquina não é a ameaça — e a corrida do agente,
que é a capacidade perigosa, só roda de lá mesmo.

Sem `QUALIDADE_TOKEN` o servidor sorteia um, **guarda em `token.local`** e imprime a URL pronta com o
IP da rede. Guardar foi o conserto de um "token inválido": sorteando a cada start, o link de ontem
morria. Para um token que você escolhe e versiona no seu `.env`:

```
QUALIDADE_HOST=0.0.0.0
QUALIDADE_TOKEN=<openssl rand -hex 16>
```

O `.env` ganha do `token.local`, e o shell ganha dos dois.

As três chaves valem no **`.env` do projeto**, não só no shell — `QUALIDADE_HOST`, `QUALIDADE_TOKEN`
e `PORT`, com os exemplos no `.env.example`. O shell **ganha** do arquivo (`PORT=4199 npm test`
continua mandando), e a suíte fixa host e token no spawn de propósito: sem isso um
`QUALIDADE_HOST=0.0.0.0` no `.env` de quem roda subiria os servidores de teste expostos e com token
sorteado — 401 em tudo.

Toda rota exige o token, por `?t=` ou pelo header `x-qualidade-token`; a comparação é
`timingSafeEqual`. Quem abre com o `?t=` recebe a página com o token embutido, e as chamadas
seguintes o levam sozinhas — sem cookie e sem sessão. Acesso negado vai para o `gate.log` com o IP.

**Por que o token não é opcional:** `/api/agente` spawna um `claude -p` com Bash **nesta máquina**.
Numa rede aberta, isso é execução remota de comando para qualquer um no mesmo Wi-Fi. Também ficariam
expostos `/api/arquivo` (conteúdo de qualquer arquivo dos 50 repos) e `/api/config-salvar` (escreve as
rotinas que o agente segue).

**A corrida do agente não roda pela rede.** O token protege o *acesso*; isto protege a
*capacidade*: `/api/agente` recusa por IP de origem, mesmo com o token certo, e a tela pela LAN nem
desenha o botão — token vazado, máquina emprestada ou aba esquecida não viram execução de comando
aqui. As decisões já gravadas valem igual para quem está vendo de fora.

CSS, JS e ícone ficam **fora** do token: a URL deles vem do HTML sem o `?t=`, e exigir token ali
dava 401 no `app.js` — o app não iniciava e a tela ficava carregando para sempre. `/` e todo `/api/`
seguem exigindo.

### Link com a tarefa

`?chamado=UND-1638&projeto=migrate-mongo` abre a tela já no chamado e no repo certos. A URL
acompanha a navegação (`history.replaceState`), então dá para copiar da barra do navegador — ou usar
o 🔗 no cabeçalho — e mandar para alguém. Com token, o `?t=` continua na URL e vai junto.

Para acesso de fora da LAN, **não** exponha na internet: túnel SSH
(`ssh -L 4100:localhost:4100 <máquina>`) ou Tailscale, que autenticam antes de chegar aqui.

## O que a tela mostra, e o que ela deliberadamente não mostra

**Fora da tela**, porque são corrigidos: comentário acima de `class`, comentário dentro do
`definition` de um model, comentário em migration, `console.log` em migration, bloco de comentário
longo, literal onde cabe enum, arquivo fora da pasta convencional, declaração solta no topo, e a
anotação da PR no chamado.

**Fora da tela** por outro motivo: o **build**, que só roda depois da PR aceita — conferir build
antes do merge não responde nada.

**Na tela**, numa lista só, o que exige alguém decidindo:

| Cartão | O que julgar |
|---|---|
| Cobertura da análise | quantos arquivos do diff foram de fato conferidos — o denominador |
| Branch certa e chamado | branch no padrão do ID, arquivos não commitados |
| Mesclagem | aparece só quando a PR está mesclada: entrou tudo, ou sobrou trabalho depois |
| Política de testes | spec novo é permitido neste repo? o teste quebra se você reverter a correção? |
| Lint do projeto | o linter **do próprio projeto**, nos arquivos do diff |
| Índices e performance | as queries que entraram no diff, com o padrão de risco de cada uma |
| Vale extrair ou eliminar? | métodos longos novos, blocos repetidos, nomes que já existem no repo |
| Pontos de atenção da IA | o que o agente achou e vale registrar — teto de 10 |

Eram 4 abas. Com 6 a 11 cartões, paginar resolvia um problema que o **cartão alto** criava: virou
linha, e a paginação deixou de fazer sentido. São 4 por fileira, todos nascem **recolhidos** — quem
resume o conjunto é a linha de veredito acima — e o expandido ocupa a fileira inteira.

O rótulo de cada cartão diz o que aconteceu, e dois deles são fáceis de confundir:

| Rótulo | Quer dizer |
|---|---|
| `ok` / `aviso` / `atenção` | a checagem rodou e este é o resultado |
| `julgar` | rodou até onde dá sozinha; o resto é decisão sua |
| `ignorado` | **não se aplica** aqui — sem linter no projeto, nenhum arquivo analisável |
| `indisponível` | **deveria ter rodado e não rodou** — diff ilegível, base não resolvida, análise com erro |

`indisponível` dizia as duas coisas, e "não se aplica" com cara de problema treina a pessoa a ignorar
o aviso. Agora só o problema leva esse rótulo, e ele vem com contorno tracejado.

### Quem decide qual é o diff certo é o agente
#### O botão que roda o agente

`🧙 pedir ao agente` na trilha roda um `claude -p` de verdade, com o prompt **fixo no servidor** — o
cliente só manda o ID, validado contra o padrão de chamado, porque página local montando prompt é
injeção de prompt. As ferramentas dele são restritas a `Bash(node|gh|curl|cd)`, `Read`, `Grep` e
`Glob`: sem Write, sem Edit, sem commit.

A corrida leva minutos, então o clique produz sinal **na hora**: o botão vira giro, um console
recebe cada passo pelo SSE (`stream-json` do CLI), e acima do botão fica o estado:

| Estado | Quer dizer |
|---|---|
| `✗ não calculado` | a tela está no palpite local |
| `◐ calculado em N de M repos` | falta decidir o resto |
| `✓ pronto — M de M repos · HH:MM` | tudo decidido, e quando |
| `⟳ agente rodando · passo N` | ainda de pé |

O estado vem do servidor, não do navegador: recarregar a página no meio de uma corrida não perde o
acompanhamento.

Na primeira corrida real o agente **acertou o que eu tinha errado à mão**: `contas-service` era a PR
#44 (eu gravei #42), `mimic` era a #77 (gravei #74) e `ai-browser-agents` era a #196, que eu não
tinha decidido. Ele também explicou cada escolha na `--nota`, incluindo que a busca `in:title` do
`gh` não devolve a PR do `jungle-monorepo`.

E ele achou um bug meu do jeito mais direto possível: **matou e reiniciou o servidor**. O
`Comparacao` lia o JSON uma vez, no import, então a decisão que ele acabava de gravar era invisível
para o servidor vivo, a verificação não batia, e reiniciar era a saída. Agora ele lê do banco a cada
chamada, e a `versao` do domínio `decisoes` — um contador que **sobe também quando quem gravou foi o
outro processo** — entra nas chaves de cache, senão a resposta velha continuaria sendo servida. O
prompt também proíbe reiniciar, mas a correção é a releitura; a proibição é só o cinto.

Decisão que **não se aplica** (branch apagada, base que não existe naquele repo) não cai no local em
silêncio: o carimbo diz `⚠ decisão ignorada: sem merge-base entre 'origin/stage' e 'UND-1971'`.


A tela **não adivinha** qual comparação vale num repo. A rotina de fim de trabalho decide e grava uma
linha na tabela `decisoes` do `qualidade.db`; aqui só se obedece. Sem decisão, a tela usa o local e
escreve `⚠ comparação não definida` no carimbo — porque **palpite não anunciado** foi o que criou o
problema.

Automatizar foi tentado e falhou por um motivo concreto. Num chamado real havia **22 branches em 12
repos** e, num único repo, **7 PRs em 7 branches**: seis mescladas e a aberta sendo outra. Nenhuma
regra local distingue "a PR que importa" das outras. Pior, a topologia degrada exatamente quando
mais se precisa dela: depois do merge, `merge-base(branch, origin/stage)` é a **própria ponta da
branch**, então o diff sai vazio por construção.

| Repo | A PR mostra | Topologia mostrava | Com a decisão |
|---|---|---|---|
| `crohc-view` | 1 | **0** | 1 |
| `migrate-mongo` | 4 | **0** | 4 |
| `integrations-core` | 3 (PR #856, aberta) | **1** (comparava com a #824, mesclada) | 3 |
| `integrations-mimic` | 65 | **0** | 65 |

9 de 9 batendo depois de decidir. E a decisão carrega **o veredito**, não só a base:

```bash
node --disable-warning=ExperimentalWarning qualidade/ferramentas/comparacao.mjs \
  definir UND-1638 integrations-core-rivio-one --pr=856 \
  --nota="6 PRs mescladas antes; a aberta e a 856"
node --disable-warning=ExperimentalWarning qualidade/ferramentas/comparacao.mjs listar UND-1638
```

| Fonte | Quando | Base usada |
|---|---|---|
| `--pr=N` | existe PR | `baseRefOid…headRefOid` — a mesma comparação do GitHub |
| `--stage` | ainda não há PR | branch × `origin/stage` |
| `--branch=X --base=Y` | base que não é a de sempre | o que você disser |

`situacao` é `resolvido` ou `aberto`, e vem do estado da PR **a menos que** você diga o contrário com
`--resolvido`/`--aberto`: PR mesclada com trabalho pendente depois dela é `aberto`, e só quem leu
sabe disso.

Uma comparação, um lugar: `lib/comparacao.mjs`. O diff, as checagens, a análise de AST e o lint pedem
a base para ele. Cada um resolvendo a sua era o que fazia o cartão de cobertura discordar do diff
desenhado logo abaixo dele.

Onde a decisão para, e como olhar o que está gravado: [O estado fica num
`qualidade.db`](#o-estado-fica-num-qualidadedb-não-mais-em-json).

### Branch já mesclada: topologia primeiro, merge-tree depois

A base não vem de ordem fixa de nomes, vem de **topologia**: entre `origin/desenv`, `origin/stage`,
`origin/main` e `origin/master`, ganha a que já **contém** a branch; empatando, o merge-base mais
recente. Com base errada, uma branch mesclada em `main` mostrava 17 arquivos de diff falso.

Só que topologia não vê **merge por squash**: o commit da branch não fica ancestral de ninguém, e o
diff inteiro reaparece como se fosse trabalho aberto. Quando a topologia diz "não contém", a segunda
pergunta é:

> **mesclar esta branch mudaria o destino?**

Quem responde é `git merge-tree --write-tree`, comparando a árvore do merge com a do destino. Nada
muda → mesclado (a tela diz `mesclado (squash)`). Muda em N arquivos → são esses N, e só esses, que
o diff mostra.

`git diff` responde outra coisa e por isso não serve: ele mistura o que o **destino** ganhou de
terceiros com o que a branch tem a mais. No UND-1638 isso marcou **2 arquivos já mesclados** como
pendentes, porque stage tinha andado por cima deles depois do squash. Sobrou 1 arquivo — e esse é
real: mesclar acrescentaria 6 linhas de teste, com conflito.

Conflito conta como divergência a mostrar (exit 1 do merge-tree não é erro, a árvore vem igual). E
como merge-tree só vê commit, alteração **não commitada** é unida à lista à parte — senão sumiria.

Medido no UND-1638, 9 repos, **três causas diferentes** para o mesmo sintoma:

| Repos | O que era | O que a tela faz |
|---|---|---|
| 6 | mesclado com o commit ancestral | topologia já resolvia — 0 arquivos |
| 1 | mesclado por **squash** | 11 arquivos de diff falso → 0, pelo merge-tree |
| 1 | `origin/stage` local **atrasado** | cartão `atenção` com o `git fetch` a rodar |
| 1 | destino andou por cima + 6 linhas fora do merge | cartão `aviso` e o **1** arquivo que falta |

A cópia atrasada é a única que a máquina não resolve sozinha: se o merge nem existe no seu `.git`,
nenhuma pergunta local descobre isso. O que a tela faz é **comparar a data do merge da PR com a da
sua cópia** e dizer qual comando resolve, em vez de mostrar arquivo antigo como pendente.

### O que cada camada cobre, e o que não cobre

| Camada | Cobre | Não cobre |
|---|---|---|
| regras de texto (`checar-diff`) | `.js .mjs .cjs .jsx` **`.ts .tsx`** | qualquer outra extensão — declarada arquivo a arquivo |
| análise por AST (`lib/ast.mjs`) | `.js .mjs .cjs .jsx` | **TypeScript**, Python, Java — o acorn recusa e o cartão diz `ignorado` |
| lint | o que o linter do repo cobrir | repo sem linter — o cartão diz `ignorado`, "nenhum linter configurado" |

As regras de texto valem em TS porque são sobre comentário e declaração no topo, que não precisam de
parser. A análise de AST não: o acorn é um parser de JS e **recusa anotação de tipo**. Um cartão que
não leu o arquivo diz que não leu.

**A Cobertura soma as duas camadas.** Antes ela contava só as regras de texto, e num repo Python
dizia "0 de 3 analisados — nada aqui foi conferido" **enquanto o ruff do próprio repo conferia os 3**.
Agora cada arquivo cai num de três lugares:

| Onde cai | Exemplo | Cartão |
|---|---|---|
| regras de texto | `.ts`, `.js` | conta como conferido |
| linter do repo | `.py` com `.venv/bin/ruff` | conta como conferido, dizendo por qual linter |
| **nada** | `.java`, `.py` sem venv | `atenção` — é só aqui que o alarme toca |

`.md`, `.json` e `.yaml` ficam de fora do alarme (**sem regra aplicável**): nenhuma ferramenta aqui
tem regra para eles, e alarmar faria o cartão disparar em toda branch que mexe num README.

**Creditar o linter abriu um buraco que precisou de conserto no mesmo lugar:** linter que **não
roda** devolvia lista vazia, e lista vazia lê como aprovação. Agora "não rodou" é distinto de "limpo"
— o cartão do lint fica `indisponível` com o motivo, e a Cobertura **desfaz o crédito** que tinha dado.
E config de eslint sem `node_modules` não conta como camada: sem `npm install` o `npx eslint` não roda,
e creditar isso seria inventar cobertura.

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
  `.find(x => ...)` de array pelo **tipo do nó** do primeiro argumento. Os 11 casos certo/errado
  rodam em `checar-diff.mjs --autoteste`, junto com os das checagens.

  Recorte é reconhecido pela **forma do nome** — `id<Entidade>` ou `<entidade>Id` —, não por lista:
  a lista fixa não conhecia `idPendenciaManual` nem `guiaId` e acusava dois filtros certos do
  UND-1991. E filtro com **espalhamento** (`{...conta, ativa: true}`) não é acusado de falta de
  recorte: os campos vêm de outro lugar e a ferramenta não os vê — afirmar ali é o falso positivo
  que ensina a ignorar o aviso.
- **refatoração**: método novo com mais de 40 linhas pelo **span do nó**, corrida de 4+ linhas
  idênticas repetida no diff, e nome de método novo que já aparece em outro arquivo (`git grep`, não
  memória)

## O estado fica num `qualidade.db`, não mais em JSON

Quatro coisas que a tela e as ferramentas guardam vivem em tabelas de um SQLite em
`qualidade/qualidade.db` (`lib/db.mjs`): as **decisões** de comparação (`decisoes`), os **pontos de
atenção** (`pontos`), o **catálogo de repos** (`repos`) e o **histórico de corridas** do agente
(`corridas`). Antes eram, na ordem, `comparacoes.json`, `pontos-atencao.json`, `repos.json` e um
arquivo por chamado em `corridas/`.

**Os quatro JSONs continuam no disco de propósito — são o backup de quem migrou. Mas são lidos UMA
vez.** No primeiro boot depois da migração cada um é importado e a importação fica marcada numa
tabela `importacoes`; daí em diante **editar o JSON à mão não muda mais nada na tela**, e nada avisa,
porque é justamente a marca que impede reimportar por cima do que já está em uso. Quem mexeu num
desses arquivos esperando efeito parou aqui.

Por que trocou — três defeitos medidos, todos silenciosos:

| Defeito | Como era | Como é |
|---|---|---|
| **perda de atualização** | o servidor e o `comparacao.mjs definir` liam o arquivo inteiro, alteravam e regravavam: o último a gravar levava o arquivo, e o que o outro acabou de escrever sumia sem erro | cada escrita é o upsert da **própria linha**, e o `busy_timeout` faz o segundo processo **esperar** em vez de gravar por cima |
| **a lista inteira vindo do cliente** | `repos.salvar()` recebia os 51 repos da aba e substituía o arquivo — provado com duas abas: a aba B gravou a cópia velha e a edição da aba A desapareceu | escrita linha a linha; linha que não veio na lista fica como está |
| **invariante do catálogo como código** | "linha `fonte:'manual'` a detecção não encosta" é predicado de linha, e sobre um blob foi implementado errado duas vezes no mesmo dia | `ON CONFLICT … DO UPDATE … WHERE repos.fonte = 'detectado'` — uma instrução que **não consegue** tocar linha manual, e o `changes: 0` prova que não tocou |

As corridas ganharam a única pergunta que o formato antigo não respondia: "a corrida de ontem decidiu
diferente?". Era um arquivo por chamado com a **última**; agora todas ficam, e
`/api/agente-historico?chamado=<ID>` lista as de um chamado — a modal continua mostrando a última, e
`/api/agente-log?id=N` abre uma antiga com os passos.

O banco fica no diretório apontado por `QUALIDADE_ESTADO`, que por padrão é a raiz do projeto. Ele é
resolvido **a cada abertura**, e é isso que deixa a suíte de teste rodar contra um diretório
temporário sem tocar no seu estado.

### Como olhar o que está lá dentro

O argumento a favor de arquivo era `grep` e editor, e essa é uma capacidade real — então o banco
tem que ter caminho de saída. `ferramentas/banco.mjs` é ele:

```bash
npm run banco -- resumo         # quantas linhas em cada tabela
npm run banco -- importacoes    # o que entrou de cada JSON, e o que ficou fora
npm run banco -- exportar       # dump em <estado>/exportado/
npm run banco -- exportar /tmp/x
```

De outro diretório, ou de dentro de um prompt de agente, o mesmo sem o npm:

```bash
node --disable-warning=ExperimentalWarning qualidade/ferramentas/banco.mjs resumo
```

Cada subcomando aceita `--json`. O `importacoes` é o que responde "por que minha edição no
`comparacoes.json` não fez efeito": ele mostra a data em que aquele arquivo foi lido, quantas linhas
entraram e o que ficou de fora (pontos além do teto, por exemplo).

O `exportar` grava **na mesma forma que a importação lê**: apontar `QUALIDADE_ESTADO` para a pasta
exportada e abrir o banco lá reconstrói o conteúdo — o próprio comando imprime a linha que confere
isso. É por aí que voltam o `grep` e o editor:

```bash
npm run banco -- exportar /tmp/dump
grep -n UND-1638 /tmp/dump/comparacoes.json
```

Por domínio, quem já mostrava continua mostrando:

```bash
node --disable-warning=ExperimentalWarning ferramentas/comparacao.mjs listar            # todas as decisões
node --disable-warning=ExperimentalWarning ferramentas/comparacao.mjs listar UND-1638   # de um chamado
node --disable-warning=ExperimentalWarning ferramentas/pontos.mjs listar [--json]
```

> **Por que o `--disable-warning=ExperimentalWarning`:** `node:sqlite` é módulo experimental e o Node
> imprime `ExperimentalWarning: SQLite is an experimental feature` no stderr uma vez por processo que
> abre o banco. Sem a flag, cada chamada dessas polui a saída da rotina — que é lida por um agente.
> O `npm start`, o `npm test` e o `npm run banco` já levam a flag. **Não trocar por
> `--no-warnings`**, que calaria também aviso de verdade. Sem argumento nenhum, `comparacao.mjs` e `banco.mjs` só imprimem o `uso:`
> e não chegam a abrir o banco — aí não há aviso, com flag ou sem. O `pontos.mjs` sem argumento já
> lista, então abre o banco e avisa.

## Pontos de atenção da IA

Ficam na tabela `pontos` do `qualidade.db`, no máximo 10 registros — o teto é regra de produto, e
está tanto na função quanto num **trigger** do banco, para que um `INSERT` cru não passe por fora.

Cada ponto tem `chamado` e `projeto` — nulo significa "vale para o workspace". A aba mostra só os que
casam com o que está na tela.

```bash
node --disable-warning=ExperimentalWarning ferramentas/pontos.mjs listar
node --disable-warning=ExperimentalWarning ferramentas/pontos.mjs remover <id>
node --disable-warning=ExperimentalWarning ferramentas/pontos.mjs \
  add <id> <atencao|aviso|nota> <titulo> <detalhe> [chamado] [projeto]
```

Com o teto cheio, o 11º entra empurrando um velho — e o descarte olha a **severidade antes da
idade**: sai primeiro a `nota` mais antiga, depois o `aviso` mais antigo, e `atencao` **nunca** sai.
Com dez `atencao` na lista, o `add` falha e diz quais são, para você tirar um à mão. É o freio: ponto
novo custa um velho, então a lista não vira despejo. O `×` no cartão tira um ponto direto da tela, e
a remoção fica registrada no `gate.log`.

Num banco novo, `pontos-atencao.example.json` copiado para `pontos-atencao.json` serve de semente: é
importado no primeiro boot. Depois disso, o arquivo não é mais lido — use os comandos.

## Realce de sintaxe

`web/realce.js` — tokenizador próprio de ~150 linhas cobrindo JS/TS, Python, Java, JSON, HTML/XML,
CSS, YAML, SQL e shell, escolhido pela extensão do arquivo. Sem CDN (quebraria offline) e sem
vendorizar um highlighter inteiro (100 KB para realçar 40 linhas por vez).

O estado atravessa as linhas, porque `/* */` e docstring de Python não cabem numa linha só — e
**zera na lacuna**: errar limitado é melhor que pintar o resto do arquivo como comentário.

## Esqueleto no lugar de "carregando…"

Cada elemento que espera dado mostra um bloco na **forma** do que vem: linhas na barra, linhas de
código no diff, pílula no selo da PR, e nos cartões o **título já visível** com o conteúdo em shimmer.
A palavra "carregando" não diz quanto vem nem onde, e a tela pula quando o conteúdo entra.

Duas decisões que importam:

- o esqueleto do corpo de cada arquivo entra **quando o arquivo é aberto**, não no HTML inicial.
  Colocá-lo antes deixava **102 animações rodando** para conteúdo dentro de `<details>` fechado —
  medido, não suposto
- `prefers-reduced-motion` desliga o shimmer e deixa o bloco estático

## Cache e recarregamento

**Serve o velho e revalida atrás.** Expirado deixou de ser motivo para esperar: a tela abre com o
que já está em cache, o recálculo roda **fora do caminho da requisição**, e um evento SSE avisa
quando o valor mudou — só quando mudou de verdade, comparando uma impressão do JSON, senão o
redesenho seria piscada sem informação. Medido: `/api/chamados` expirado passou de 430 ms
(esperando a varredura) para **128 ms**, e a segunda abertura da tela inteira leva **80 ms**.

A resposta se declara: `doCache`, `desde` e `revalidando`. O carimbo do diff mostra
`do cache de HH:MM:SS · atualizando…` enquanto isso, e o redesenho **guarda a rolagem** — perder o
lugar no diff é pior que ver o dado velho por um segundo. Chaves que revalidam juntas (diff,
checagens e lint) são agrupadas em 400 ms para dar um redesenho só.

O cálculo sync (o git do diff) revalida em `setTimeout(0)`: rodando no meio da resposta ele travaria
o event loop que a resposta está usando. Uma revalidação por chave de cada vez — sem a trava, cada
pedido de uma chave velha enfileirava outra varredura.

Os TTLs (5 min, 30 s para a lista de chamados) deixaram de ser um portão e passaram a ser só o
momento de revalidar. As formas de forçar continuam:

- botão **recarregar** no cabeçalho — invalida o cache **do projeto aberto** e relê
- botão **↻ na linha do chamado** — invalida os **N repos daquele chamado**, os PRs e a lista, e refaz
  a barra mantendo o chamado aberto e o repo selecionado. Antes só dava para recarregar o repo aberto,
  e os outros seis ficavam com dado velho
- **sozinho**, quando o hook de `PostToolUse` vê um `git commit`/`merge`/`rebase`/`checkout`/`reset`:
  chama `/api/invalidar` e a tela aberta recebe o aviso por SSE, mostra um toast e relê
- o TTL, que agora dispara a revalidação em segundo plano em vez de fazer alguém esperar

O carimbo ao lado do botão diz se o que está na tela foi **lido agora** ou veio **do cache de** que
horas — é como se verifica que um reload de fato recarregou.

Duas armadilhas que apareceram construindo isso:

- **o eco do próprio pedido.** O `/api/invalidar` dispara SSE de volta para quem pediu, e o handler
  reabria o repo em paralelo com o reload explícito: o do evento populava o cache e o explícito lia a
  cópia, deixando o carimbo em "do cache" logo depois de recarregar. Resolvido por desenho, não por
  timing: quem pede e recarrega sozinho passa `silencioso=1` e não recebe o aviso. O hook não passa,
  então outras abas continuam sendo notificadas
- **invalidar não pode revarrer.** Resolver os repos do chamado com uma varredura nova custava
  **6,1 s de event loop bloqueado**; a lista já está em cache, pedida pela própria barra que disparou
  a invalidação. Agora: **0,8 ms**

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
| `ferramentas/banco.mjs <resumo\|importacoes\|exportar> [--json]` (ou `npm run banco --`) | O `qualidade.db` por fora da tela: o que cada tabela tem, o que a importação leu, e o dump para JSON |

Repo parado em outro checkout precisa do `--ref=<branch>` — sem ele a checagem olha o trabalho
errado.

`comparacao.mjs`, `pontos.mjs` e `banco.mjs` abrem o banco, e por isso vão com
`node --disable-warning=ExperimentalWarning …`. São só esses três: medido, os outros scripts da
tabela não tocam o SQLite e não imprimem aviso nenhum.

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

## O chamado na barra

Acima dos PRs vem o **link do chamado** com título e status, e o nome do chamado ganha tooltip com
título, responsável e a data em que o dado foi lido.

O servidor **não fala com o Linear** e não vai falar — colocar token de terceiro num projeto sem
dependência é dívida. Quem fala é o agente, pela sessão dele, e grava em `linear-cache.json`:

```bash
node ferramentas/linear.mjs gravar <ID> '<json>'
node ferramentas/linear.mjs ver <ID>
```

O cache tem data e a tela mostra a data: título velho serve, desde que esteja dito que é velho. Sem
cache, o **link ainda funciona** — a URL sai do ID mais o slug do workspace em `linear.json`.

O Linear é a fonte **autoritativa** de quais PRs são do chamado: num caso real conhecia **25**,
contra 10 da varredura local somada à busca na organização, incluindo PRs em repos que não existem
naquele workspace. Por isso ele entra como terceira fonte, e a rotina manda buscá-lo **num subagente
em paralelo** — é I/O de rede, não tem por que bloquear a conferência.

## Os agentes abertos na máquina

No pé da barra — visível nas três abas — um cartão diz quantas sessões do **Claude Code** estão
abertas nesta máquina:

```
┌────────────────────────────────────┐
│  ●  3  agentes abertos           › │
│        2 trabalhando agora · 1 não │
│        informa                     │
│  ▬▬▬▬▬▬▬▬   ▬▬▬▬▬▬▬▬   ┄┄┄┄┄┄┄┄    │
└────────────────────────────────────┘
```

Clicar abre uma modal com uma linha por sessão: o que foi pedido, a ferramenta que está rodando
agora, a última coisa que ela disse, e há quanto tempo está aberta.

Para que serve: sessão esquecida aberta há um dia é indistinguível de sessão trabalhando, e as duas
custam a mesma janela de contexto e o mesmo dinheiro.

**A fileira de barrinhas é o que o número sozinho não diz** — uma por agente: acesa e pulsando é
quem trabalha, apagada é quem espera, tracejada é quem não informa estado. Três pulsando é uma
tarde de trabalho; três apagadas são três sessões esquecidas abertas. Acima de seis elas quebram
linha em vez de virar fiapo de 1px.

O **tooltip enumera em vez de subtrair**: CLI antiga não grava `status`, e chamar isso de "parado"
seria afirmar o que não se sabe. Por isso `/api/sessoes` devolve `ocupadas`, `paradas` e `mudas`
separados. A enumeração fica no tooltip e não na linha porque os três estados não cabem em 300px —
e as barrinhas já mostram os três.

> ⚠️ **"agente" aqui não é o agente da tela.** `/api/agente`, `estadoAgente` e a modal de estado são
> o agente que a própria ferramenta dispara para decidir comparação e implantação. Isto é outra
> coisa, e por isso o código chama de **sessão**: `lib/sessoes.mjs`, `/api/sessoes`, `#sessoes`.
> `/api/agentes` e `/api/agente` seriam a mesma rota para quem lê rápido.

### De onde vem o dado

De `~/.claude/sessions/<pid>.json`, o mesmo registro que `claude agents --json` lê, mais o fim do
transcript de cada sessão em `~/.claude/projects/`. O comando oficial custa **170 ms** por chamada
e a leitura direta **0,05 ms** — 3.200× mais barata, e o contador reconsulta sozinho a cada 30 s.

O preço é acoplar a um formato interno da CLI. Por isso **todo campo é opcional**: o que sumir vira
ausência na tela, nunca exceção. Sessão cujo processo morreu sai da lista sozinha, porque a
liberação é por `kill(pid, 0)` — que não mata, pergunta.

Duas rotas de custo diferente, como em `implantacao.mjs`:

| Chamada | O que faz | Quem usa |
|---|---|---|
| `/api/sessoes` | conta e diz quem está ocupado; não abre transcript | o contador da barra |
| `/api/sessoes?detalhe=1` | acrescenta pedido, ferramenta e última fala | a modal, enquanto aberta |

### Três ausências que a tela distingue

Ausência calada é o defeito que este projeto persegue, e aqui havia três jeitos de somer com o
pedido. A modal diz qual é qual:

| O que aparece | O que aconteceu |
|---|---|
| `sem transcript em disco` | sessão de IDE/SDK — ela não grava transcript |
| `pedido além do trecho lido` | o orçamento de leitura (4 MB) acabou antes de achar |
| `—` | achou o transcript, e não havia pedido nele |

A leitura **anda para trás em pedaços** de 256 KB até achar o pedido, porque numa sessão que
trabalhou muito ele fica longe do fim: medido, 502 KB atrás num transcript de 881 KB. A primeira
versão lia uma janela fixa e mostrava `—` — indistinguível de "não pediu nada".

**Só leitura.** A tela não fala com essas sessões, não manda mensagem e não encerra nenhuma.

## As duas linhas que a rotina escreve

```
─────────── rodando agente de qualidade · início · ABC-123 ───────────
─────────── agente de qualidade · fim · ABC-123 ───────────
```

A de fim carrega o **veredito**, não um "pronto". Os alertas são **uma linha**: contagens primeiro,
e depois do travessão o pior achado **com o lugar** — número sozinho manda a pessoa procurar.

```
─────────── agente de qualidade · fim · ABC-123 ───────────
  <título do chamado> · <status>
  <url do Linear>

  2 atenção · 1 aviso · 14 fora de cobertura (.py) — build PULADO em #121 e #37
  PRs 25 · 0 abertas · 23 mescladas · nenhum repo sem PR
  9 repos · tela: http://localhost:4100
────────────────────────────────────────────────────────
```

Sem nenhum achado, a mesma linha — e `fora de cobertura` continua ali:

```
  0 achados · 14 fora de cobertura (.py) — nada nesses arquivos foi conferido
```

Banner que só diz "terminou" é o silêncio-lido-como-aprovação em outra forma, e `fora de cobertura`
**nunca é omitido, nem em zero**: é o denominador que impede ler "nenhum achado" como aprovado.

## Testes

```bash
npm test        # rotas, forma das respostas, cache, mesclagem, o banco, as CLIs e a doutrina
```

**O `npm test` roda contra um diretório temporário**, por causa do `QUALIDADE_ESTADO=$(mktemp -d)`
que está no script — sem ele a suíte escreveria no `qualidade.db` de verdade e apagaria a escolha de
repos, o que já aconteceu. **Toda sonda avulsa (`node -e`, um script solto, um teste manual) tem que
levar a mesma variável na frente.** Ela é lida a cada abertura do banco, então basta prefixar:

```bash
QUALIDADE_ESTADO=$(mktemp -d) \
  node --disable-warning=ExperimentalWarning ferramentas/comparacao.mjs listar
```

Existe porque, num único dia de desenvolvimento, **cinco quebras passaram em silêncio**: uma função
apagada numa reescrita, um método apagado ao substituir outro, uma flag ignorada depois de acrescentar
outra, um nome de regra renomeado num lugar só (o cartão nunca achava nada), e uma cópia de função que
fez uma otimização virar regressão de 16×. Todas eram detectáveis batendo nas rotas e conferindo a
forma da resposta.

O teste **descobre o alvo** em vez de fixar nome de repo — vale em qualquer workspace — e faz `skip`
com motivo declarado quando não há trabalho aberto, em vez de passar em falso. Ele procura um repo com
diff **de verdade**: pegar o primeiro fazia as rotas de diff virarem `skip` quando ele estava mesclado,
e a suíte ficava verde sem exercitar nada.

Dois casos montam um **repo git temporário** com merge por squash, porque essa é a situação que a
topologia não vê. Um exige o jeito certo (mesclado → diff vazio) e o outro exige o errado (commit
depois do merge → continua aparecendo): sem o segundo, a correção viraria cegueira.

### `doutrina.json` — o de-para que impede "metade implementado"

Cada regra do time aparece com a checagem que a implementa, ou com o **motivo de não ter**. O
`teste/doutrina.mjs` falha se:

- uma regra declarada não existe como checagem
- uma checagem existe e não está declarada (de onde ela veio?)
- a flag `corrige` divergir do que o `--corrigir` realmente apaga
- uma checagem que **apaga código** não tiver exemplo do jeito certo **e** do errado

O último pegou uma falha na primeira execução: `console-log-em-migration` apagava linha sem ter o par
de calibração. É o furo que motivou o arquivo: `migration não leva comentário NEM console.log` é uma
frase da doutrina, e ficou implementada pela metade sem ninguém ter como saber.

## O log dos disparos

```bash
npm run log                  # resumo desde o início
npm run log -- --dias=30
```

Responde a pergunta que o `gate.log` existe para responder: **isto pegou algo ou virou paisagem?**
Agrupa por ação e resultado, mostra os projetos mais tocados, e diz na última linha quantos disparos
mudaram algo — sugerindo desligar o hook se a resposta for zero por semanas.

## Regra para mexer nas checagens

Uma checagem só entra depois de um erro que aconteceu de verdade, e só com **exemplo do jeito certo
e do errado** em `autoteste()`, os dois passando:

```bash
node ferramentas/checar-diff.mjs --autoteste     # 16 casos
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

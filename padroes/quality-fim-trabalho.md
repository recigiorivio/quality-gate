---
description: Rotina de fim de trabalho — corrigir o mecânico, conferir o que exige julgamento
argument-hint: [ID-DO-CHAMADO]
---

Rotina de **fim** de trabalho para o chamado: **$ARGUMENTS**

> **Padrão que veio na instalação.** As instruções são reais, de uma rotina em uso. Os caminhos dos
> comandos já foram reescritos para este clone. O que é do seu time está marcado com `<...>`. Troque
> pela aba **Configurações** da tela.

A divisão é a regra desta rotina: **o que é mecânico se corrige, o que exige julgamento se confere.**
Item mecânico não vira pergunta nem cartão na tela — vira commit.

Nada aqui commita, empurra ou mescla sem confirmação explícita.

## Antes de qualquer coisa — anunciar

Escrever esta linha **antes** do primeiro comando, para o começo da rotina ser visível na rolagem:

```
─────────── rodando agente de qualidade · início · <ID> ───────────
```

E, assim que o rastreador responder (é o primeiro passo), as duas linhas do que se aprendeu:

```
  <título do chamado> · <status>
  <url do chamado>
```

Se nenhum ID foi passado, anunciar com `(descobrindo o chamado)` no lugar do ID.

## 1. Corrigir — sem perguntar, sem relatar como pendência

### 1.0 O que é da tarefa — decidir e colocar em stage

**Só quando ainda não há PR** para este repo. Com PR aberta, o que entra é o que já está nela; mexer
no índice aqui é mexer no que o revisor está lendo.

Antes de qualquer conferência, em cada repo do chamado, decidir **arquivo por arquivo** o que pertence
à tarefa e colocar em stage só isso. Tudo que vem depois — as checagens, o diff da tela, a PR —
trabalha em cima do que o git rastreia: arquivo novo que nunca passou pelo `git add` **não aparece em
diff nenhum**. Já aconteceu de a migração inteira do chamado ficar fora da tela porque ninguém tinha
adicionado a pasta.

```bash
git -C <projeto> status --porcelain          # M = modificado, ?? = novo e não rastreado
git -C <projeto> diff --stat                 # o que já é visto
```

| É da tarefa | Não é |
|---|---|
| arquivo com o **ID do chamado** no caminho (`migrations/ABC-1234/`, `ABC-1234.spec.js`) | `.idea/`, `.vscode/`, `*.iml`, `.DS_Store` |
| arquivo que o código alterado **importa ou referencia** (enum novo, helper, spec do arquivo mexido) | `.env`, `*.local`, `LOCAL.md`, log, saída de build, `node_modules/` |
| arquivo no **mesmo domínio** dos modificados | lockfile sem dependência nova no manifesto |
| tradução/migração exigida por chave nova que você criou | arquivo que outro chamado tocou — conferir com `git log -3 -- <arquivo>` e as outras branches |
| — | mudança só de formatação em arquivo que a tarefa não precisava tocar |

Em dúvida, **não decida sozinho**: liste o arquivo com o que aponta para cada lado e pergunte. Errar
para dentro suja a PR com coisa alheia; errar para fora deixa a migração fora do deploy.

```bash
git -C <projeto> add <arquivos da tarefa>    # um por um, ou a pasta com o ID — nunca `git add -A`
git -C <projeto> status --porcelain          # o que sobrou de fora fica visível, e é dito
```

Depois de adicionar, dizer em uma linha por repo: `N em stage · M deixados de fora: <quais e por quê>`.
O que ficou de fora **não** é reprovação, é declaração — a pessoa decide se limpa ou se ignora.
Adicionar ao índice não é commitar: o commit continua exigindo confirmação, como sempre.

**O que ficou de fora e continua sujando o `git status`** se separa por quem sofre o problema — a
escolha errada gera PR de uma linha que não ajuda ninguém, ou faz cada dev redescobrir o mesmo
incômodo:

| Quem sofreria | Onde tirar |
|---|---|
| todo dev, em máquina limpa | `.gitignore` do repo, via branch + PR (e duplicar no `exclude` como interino até o merge) |
| só esta máquina | `.git/info/exclude` — dentro do `.git/`, nunca commitado, sem PR |
| a máquina, em qualquer projeto | `~/.gitignore_global` — é onde `*.iml` resolve vários repos de uma vez |

Para a tela refletir o que entrou: `node {{CLONE}}/ferramentas/checar-diff.mjs <projeto> --staged`
olha o índice, e o diff passa a mostrar os arquivos novos.

### 1.1 Comentários, estrutura, enumeradores, pastas

```bash
node {{CLONE}}/ferramentas/checar-diff.mjs --autoteste        # antes de confiar na saída
node {{CLONE}}/ferramentas/checar-diff.mjs <projeto> --corrigir
```

O `--corrigir` apaga sozinho as violações que são mecânicas: comentário acima de `class`, comentário
dentro da definição de model, `console.log` em migração. Ele imprime cada linha removida.

O que ele **não** corrige, porque exige decidir, e por isso é seu trabalho fazer na mão, também sem
perguntar:

| Achado | O que fazer |
|---|---|
| bloco de comentário > 2 linhas | reduzir a 2, ou apagar se descreve *o quê* — o porquê fica |
| literal numérico onde cabe enum | trocar pelo membro do enum; se o enum não existe, criar no padrão do repo |
| arquivo fora da pasta convencional | mover e **arrumar os imports** — o `git mv` sozinho quebra |
| `const MAPA = {}` ou função solta no topo | de-para → pasta de enums; auxiliar → método `_nome` da classe |

**Comentário é passo de conferência, não de bom senso** — bom senso já falhou muitas vezes. Antes de
mostrar qualquer edição:

```bash
grep -nE "^\s*(//|#|<!--)" <arquivos alterados>
```

Alvo é **uma linha**, teto duas. Bloco com narrativa não passa. E o que nunca vira comentário —
medição, número, histórico da decisão, justificativa de posicionamento — vai para a **descrição da
PR**, onde envelhece sem enganar: número em comentário vira mentira sem aviso. Se algum repo seu pede
docstring por convenção, anotar a exceção aqui.

Chave nova de label ou tradução: criar a **migração de tradução**. Sem isso a tela mostra a chave crua
e nada falha em review.

### 1.2 Chamado — link, título e a lista completa de PRs

Dispare num **subagente, em paralelo**: é I/O de rede e não tem por que bloquear a conferência.
Prompt para ele:

> Para cada ID `<IDs>`: leia o chamado no rastreador. Extraia `titulo`, `status`, `atribuido`, `url`,
> e `prs` = dos anexos, só os que apontem para PR, cada um como `{titulo, url}` com o prefixo
> `<ID>: ` **ou** `<ID> - ` removido do título. Grave com
> `node {{CLONE}}/ferramentas/linear.mjs gravar <ID> '<json>'` a partir da raiz do workspace. Se um
> chamado não existir ou a leitura falhar, **não invente**: pule e diga qual e por quê.

Isso alimenta o link do chamado, o título e o status que a tela mostra acima dos PRs, e a lista de PRs
do rastreador como terceira fonte. O servidor não fala com o rastreador e não vai falar — quem fala é
o agente, e o cache tem data, que a tela mostra.

Vale porque o rastreador é a fonte **autoritativa** de quais PRs são do chamado: num caso real trouxe
**25**, contra 10 da varredura local somada à busca na organização, incluindo PRs em repos que não
existem neste workspace. Na tela, `◇` marca o que só a busca encontrou e `◈` o que só o rastreador
conhece — **conferir esses também**: repo que não está no disco não entra em nenhuma outra checagem.

### 1.3 PR anotada no chamado

Conferir se o comentário com os links está no chamado e, se não estiver, **colocar**. Formato:

```
Merge Request
- projeto: <url>
```

Um link por projeto, no máximo 2 blocos na nota, editar em vez de empilhar, sem repetir link que já
está nos anexos. **Abrir PR que não existe continua exigindo confirmação** — anotar a que existe, não.

### 1.4 Lint

```bash
cd <projeto> && npm run check          # e `npm run fix` para o auto-fixável
```

Se algum repo seu usa outro linter, ou tem front e back com scripts diferentes, anotar os comandos
aqui — é o tipo de coisa que se procura duas vezes por semana.

Corrigir o que o lint aponta **nos arquivos que você tocou**. Erro em arquivo que você não tocou se
relata, não se corrige.

### 1.5 Comparação — decidir qual diff a tela mostra

**Esta decisão é sua, e é obrigatória.** A tela não adivinha: sem decisão ela usa a comparação local e
escreve `⚠ comparação não definida` no carimbo.

Automatizar não deu, e o motivo é concreto: num chamado real havia **22 branches em 12 repos** e, num
único repo, **7 PRs em 7 branches** — seis mescladas e a aberta sendo outra. A topologia local piora
depois do merge, porque o `merge-base` passa a ser a **própria ponta da branch** e o diff sai vazio: a
tela mostrava 0 arquivo em 8 repos onde as PRs mostravam de 1 a 65.

Para cada repo do chamado, ver o que existe e decidir:

```bash
cd <projeto> && gh pr list --search "<ID> in:title" --state all \
  --json number,state,headRefName,baseRefName,updatedAt,title
```

| O que você vê | O que gravar |
|---|---|
| uma PR, mesclada | `--pr=N` (a situação vem do estado dela: `resolvido`) |
| várias PRs, uma aberta | `--pr=<a aberta>` — é onde está o trabalho de agora |
| várias, todas mescladas | `--pr=<a última>`, e `--nota` dizendo que as outras já entraram |
| PR nenhuma ainda | `--stage` — branch contra a base observada, situação `aberto` |
| base diferente da usual | `--branch=X --base=origin/<base>` |

```bash
node --disable-warning=ExperimentalWarning {{CLONE}}/ferramentas/comparacao.mjs \
  definir <ID> <projeto> --pr=<N> --nota="<por que esta, e não as outras>"
node --disable-warning=ExperimentalWarning {{CLONE}}/ferramentas/comparacao.mjs listar <ID>
```

`--resolvido` / `--aberto` sobrescrevem a situação quando o estado da PR não conta a verdade — PR
mesclada com trabalho pendente depois dela é `--aberto`.

**Onde a decisão para:** uma linha da tabela `decisoes` do banco de estado, gravada por upsert só
dela — é isso que impede a gravação da tela e a do terminal se atropelarem. **Editar o
`comparacoes.json` à mão não muda mais nada**: ele foi lido uma vez, na primeira importação, e ficou
no disco como backup.

Para inspecionar: `comparacao.mjs listar <ID>` (aceita `--json`), e o banco inteiro pelo `banco.mjs`:

```bash
node --disable-warning=ExperimentalWarning {{CLONE}}/ferramentas/banco.mjs resumo
node --disable-warning=ExperimentalWarning {{CLONE}}/ferramentas/banco.mjs importacoes
node --disable-warning=ExperimentalWarning {{CLONE}}/ferramentas/banco.mjs exportar /tmp/dump
```

`importacoes` é o que responde "por que minha edição no JSON não fez efeito": diz a data em que aquele
arquivo foi lido e o que entrou. `exportar` grava o dump em JSON, na mesma forma que a importação lê —
é assim que `grep` e editor continuam servindo.

**Confirme com número.** Depois de gravar, o número de arquivos da tela tem que bater com o da PR:

```bash
cd <projeto> && gh pr view <N> --json files -q '.files | length'
curl -s "{{TELA}}/api/arquivos?projeto=<projeto>&chamado=<ID>" \
  | python3 -c "import json,sys; print(len(json.load(sys.stdin)['arquivos']))"
```

Não bater é sinal de decisão errada, não de tela errada.

## 2. Conferir — o que exige julgamento

A tela mostra exatamente estes, e só estes. Se ela não estiver no ar: `/quality-subir-tela`.

| Cartão | O que julgar |
|---|---|
| Cobertura da análise | quantos arquivos do diff foram **de fato** conferidos, e por qual camada |
| Branch certa e chamado | branch no padrão do ID, arquivos não commitados |
| Mesclagem | PR mesclada e ainda sobrou coisa? é trabalho fora do merge |
| Política de testes | spec novo é permitido neste repo? o teste **quebra** se você reverter a correção? A suíte do projeto **não** roda aqui — ela é da implementação, leva minutos e o resultado não muda esta decisão |
| Lint do projeto | o linter do próprio repo, nos arquivos do diff |
| Índices e performance | varredura completa, tipo divergente, filtro em campo dentro de array |
| Vale extrair ou eliminar? | vale extrair? tem código morto? **já existe?** (grep, não memória) |

São cartões numa lista só, todos recolhidos — a linha de veredito acima resume. Os rótulos que
confundem: `ignorado` é "não se aplica aqui"; `indisponível` é "deveria ter rodado e não rodou".

O diff antes/depois fica abaixo das abas. Revisar ali antes de abrir ou atualizar a PR.

O **build não entra aqui**: ele só roda depois da PR aceita. Conferir build é depois do merge, não
antes.

## 3. Índices e performance (somente leitura)

Para cada query nova ou alterada:

```bash
node {{CLONE}}/ferramentas/indices.mjs <colecao> '<filtro json>'
node {{CLONE}}/ferramentas/indices.mjs <colecao> '<pipeline json>' --pipeline
```

Se a mudança foi refatoração, rodar a consulta antes e depois e comparar a saída: refatoração que muda
o resultado não é refatoração.

## 4. Registrar os pontos de atenção

```bash
node --disable-warning=ExperimentalWarning {{CLONE}}/ferramentas/pontos.mjs listar
node --disable-warning=ExperimentalWarning {{CLONE}}/ferramentas/pontos.mjs \
  add <id-kebab> <atencao|aviso|nota> "<titulo>" "<detalhe>" [chamado] [projeto]
```

Aparecem na aba **Pontos de atenção da IA** da tela, e ficam na tabela `pontos` do banco de estado.

**Teto de 10**, e o 11º entra empurrando um velho: sai a `nota` mais antiga, depois o `aviso` mais
antigo, e **`atencao` nunca é descartado** — com dez `atencao` o `add` falha e lista os ids para você
tirar um à mão. Cada ponto novo custa um velho: isso é o freio, não um limite a contornar.

**O que merece um ponto:**

| Merece | Não merece |
|---|---|
| achado que **mudaria uma decisão** sua se você não soubesse | achado que a própria tela já mostra (é redundante) |
| falha **silenciosa** — nada quebra, e o custo aparece semanas depois | tarefa pendente comum (isso é comentário no chamado) |
| dívida **fora do escopo** deste chamado, que se relata e não se corrige | opinião sobre estilo sem consequência medida |
| bug que **eu** introduzi e corrigi, se o motivo se repete | qualquer coisa sem número ou `arquivo:linha` que sustente |

`chamado` e `projeto` nulos = vale para o workspace. Preencher quando o ponto só faz sentido ali.

**Antes de adicionar, ler a lista** e tirar (`remover`) o que já foi resolvido. Lista com 10 pontos
velhos é pior que lista vazia: ninguém abre a aba duas vezes.

## 5. Fechamento — as cinco perguntas

Aqui elas são **conferência**, não levantamento: o plano do `/quality-inicio-trabalho` já respondeu
cada uma, e o que interessa agora é o que **mudou** desde então.

| # | A pergunta | O que confirmar no fim |
|---|---|---|
| 1 | dá para ver funcionando? | **isso emite sinal?** — o caminho novo loga, e dá para achar no agregador |
| 2 | aguenta o volume real? | o número do passo 3 bate com o previsto no plano |
| 3 | já existe? | o que o grep do plano não achou continua não existindo depois do código escrito |
| 4 | é a casa certa? | nenhum projeto entrou no diff sem estar justificado no plano |
| 5 | quem mais precisa saber? | roteamento, permissões em **todos** os ambientes, tradução, outras equipes |

Responder as que **têm** resposta relevante e dizer explicitamente qual não se aplica — "não muda
volume", "não tem rota nova". **Resposta que mudou desde o plano é a que mais importa:** dizer que
mudou, não só entregar o valor novo.

## 6. Antes da PR — ler a análise e PERGUNTAR

**Obrigatório, e é uma parada, não um aviso.** Antes de abrir ou atualizar PR, para cada repo do
chamado:

```bash
node {{CLONE}}/ferramentas/checar-diff.mjs <projeto> [--ref=<branch>] --json
node --disable-warning=ExperimentalWarning {{CLONE}}/ferramentas/pontos.mjs listar
```

Repo que não está em checkout na branch do chamado **precisa do `--ref=`** — sem ele a checagem olha o
trabalho errado. A tela mostra tudo isso junto: {{TELA}}

**Ler o cartão "Cobertura da análise" primeiro.** Se ele disser `0 de N arquivos analisados`, a
conferência mecânica **não aconteceu** neste repo — e "nenhum achado" ali não é aprovação, é ausência
de cobertura. Dizer isso ao usuário com essas palavras, e apoiar a conferência no lint do repo e na
leitura do diff.

Então **ler a saída** e apresentar ao usuário, em uma tabela curta:

| Coluna | O que vai |
|---|---|
| onde | `arquivo:linha` |
| o que | a regra e o trecho |
| mecânico? | se dá para corrigir sozinho ou exige decisão |

E **perguntar o que ele quer fazer** com o que foi apontado — uma pergunta com as opções concretas
(corrigir tudo o que é mecânico / corrigir item X / registrar como ponto e seguir / ignorar), não uma
pergunta aberta do tipo "quer que eu corrija algo?".

Quatro regras que fazem essa parada valer algo:

- **não abrir a PR antes da resposta.** Achado apresentado depois da PR aberta custa um segundo push e
  uma nova rodada de review.
- **não decidir sozinho** que um achado é irrelevante. Achado que eu considero pequeno pode ser
  exatamente o que ele não quer no repo — e o inverso também: ele pode querer deixar passar algo que
  eu acho grave, e isso é decisão dele.
- **dizer quando não há nada.** "0 erro, 0 aviso nos 7 repos" é resposta útil; silêncio parece que a
  checagem não rodou.
- **dizer se a suíte do repo rodou, e o resultado.** Ela é da implementação e não roda nesta
  conferência — mas entregar sem dizer que não rodou é o mesmo silêncio.

## 7. Registro

- Confirmar com o usuário **antes** de commit, push ou abertura de PR. Sempre.
- **Commit e push são atômicos:** depois de cada `git commit`, `git push` na sequência, e **conferir a
  saída** antes de reportar. "Everything up-to-date" onde devia ter enviado é branch errada, não
  sucesso.
- A base da PR é a do seu time — `origin/HEAD -> main` engana; passar `--base` explicitamente.
- Se algum repo tem branch protegida, ou convenção própria de release, anotar aqui: é o passo em que
  se descobre tarde.
- Se a base tem outros chamados dentro, cherry-pick do que é seu em vez de arrastar o resto.
- Repo cujo working tree sujo é o estado desejado (mock, sandbox): **não oferecer commit e não listar
  como pendência**. Anotar quais são.

## 7.1 Recarregar a tela

A rotina escreveu em quatro lugares — decisões de comparação, pontos de atenção, cache do chamado e o
próprio git. O hook cobre `git add/commit/merge/...` sozinho. As decisões e os pontos vão para o banco
de estado, e o servidor os enxerga sem reinício. O que ainda leva até 30 s é o que continua em
arquivo, o título do chamado sobretudo. Uma chamada fecha tudo de uma vez:

```bash
curl -s "{{TELA}}/api/invalidar?chamado=<ID>" >/dev/null
```

Sem `silencioso`: é isso que faz a aba aberta recarregar pelo canal de eventos. Se a tela não estiver
no ar, o `curl` falha e não faz diferença — não tratar erro aqui é de propósito.

## 7.2 Depois da PR — a revisão automática

**PR com base diferente da branch padrão quase nunca é revisada sozinha.** O bot responde *"Review
skipped — auto reviews are disabled on base/target branches other than the default branch"*, e isso
**não** é "não achou nada". A causa costuma estar no arquivo de configuração do bot dentro do repo,
fixando uma branch aposentada — trocar ali resolve de vez, numa PR de uma linha. Vale sugerir em vez
de disparar revisão para sempre.

```bash
gh api repos/<org>/<repo>/pulls/<N>/comments \
  --jq '.[] | select(.user.login|test("<bot>";"i")) | {path, line, body}'
```

Três detalhes que já produziram leitura errada:

- o login do bot na API costuma ter sufixo (`...[bot]`) — filtro por igualdade exata devolve vazio e
  parece silêncio
- *"Review triggered"* é só o ACK do disparo; o que marca revisão pronta é **`Actionable comments
  posted: N`** ou um review em `pulls/<N>/reviews`
- a revisão é **incremental**: em PR já revisada, cobre só os commits novos

**Disparar revisão é ação para fora — perguntar antes.** E o achado do bot pode ser invenção a partir
da descrição da PR: conferir no código e levar **com veredito e evidência**, não a lista crua.

## 8. Fechar — anunciar o veredito

Última coisa da rotina. **A linha de fim carrega o veredito, não um "pronto"** — banner que só diz
"terminou" é o silêncio-lido-como-aprovação em outra forma.

```
─────────── agente de qualidade · fim · <ID> ───────────
  <título do chamado> · <status>
  <url do chamado>

  <n> atenção · <n> aviso · <n> fora de cobertura (<extensões>) — <o pior achado, com onde>
  PRs <n> · <n> abertas · <n> mescladas · sem PR em: <repos>
  <n> repos · tela: {{TELA}}
────────────────────────────────────────────────────────
```

**Os alertas são UMA linha.** Contagens primeiro, e depois do travessão o **pior achado com o lugar** —
número sozinho manda o usuário procurar. Exemplo:

```
  2 atenção · 1 aviso · 14 fora de cobertura (.py) — build PULADO em #121 e #37
```

Sem nenhum achado, a mesma linha, e o `fora de cobertura` continua ali:

```
  0 achados · 14 fora de cobertura (.py) — nada nesses arquivos foi conferido
```

Regras da linha:

- **`fora de cobertura` nunca sai**, nem em zero. É o denominador, e é o que impede a leitura de que
  "nenhum achado" significa aprovado.
- **contagem zero sai**, exceto essa: `0 atenção · 0 aviso` vira `0 achados`.
- se um número não pôde ser levantado, escrever `?` e dizer por quê — nunca chutar.
- o detalhe de cada achado está na tela; a linha só aponta para onde olhar.

## Limites

- Infraestrutura, ambiente de teste e produção: **somente leitura**. Entregar o comando para o usuário
  rodar.
- Banco do ambiente de teste: somente leitura.
- Achado fora do escopo do chamado se relata, não se implementa.

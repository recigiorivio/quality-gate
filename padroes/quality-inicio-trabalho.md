---
description: Rotina de início de trabalho — chamado, dados reais, plano em md
argument-hint: [ID-DO-CHAMADO]
---

Rotina de **início** de trabalho para o chamado: **$ARGUMENTS**

> **Padrão que veio na instalação.** As instruções são reais, de uma rotina em uso. Os caminhos dos
> comandos já foram reescritos para este clone. O que é do seu time está marcado com `<...>` — nome
> dos repos, base das branches, obrigações que atravessam. Troque pela aba **Configurações** da tela.

Escrever esta linha **antes** do primeiro comando:

```
─────────── rodando agente de qualidade · início · $ARGUMENTS ───────────
```

E, assim que o rastreador de chamados responder, as duas linhas do que se aprendeu — título com
status, e a URL. Sem ID passado, anunciar com `(descobrindo o chamado)` no lugar dele.

Ao terminar, fechar com o veredito no mesmo formato do `/quality-fim-trabalho`, passo 8 — trocando
`fim` por `plano pronto` e listando o que o plano encontrou.

Se nenhum ID foi passado, rodar `node {{CLONE}}/ferramentas/contexto.mjs` para descobrir as branches
abertas e perguntar qual é o chamado. Não presumir.

Executar na ordem. Cada passo produz fato, não impressão — e o que não deu para verificar deve ser
dito como não verificado.

## As cinco perguntas — aqui elas ainda são baratas

No `/quality-fim-trabalho` elas são conferência: *o que eu fiz aguenta?* Aqui são **levantamento**:
*o que eu preciso saber antes de escrever?* Mesma lista, preços diferentes. Respondida agora, cada
uma custa um grep ou uma consulta; respondida no fim, **#3 e #4 custam refazer o trabalho** e **#5
custa esperar outra equipe**.

| # | A pergunta | Onde ela é respondida nesta rotina |
|---|---|---|
| 1 | Dá para ver funcionando? | passo 5 — e o que o fluxo **não** emite hoje já é achado do plano |
| 2 | Aguenta o volume real? | passo 4, com número do ambiente de teste, nunca com adjetivo |
| 3 | Isso já existe? | passo 7.1 — grep contra o remoto, nunca memória |
| 4 | É a casa certa? | passo 7.2 — com justificativa por projeto |
| 5 | Quem mais precisa saber? | passo 7.3 — a única com prazo de terceiro, por isso vem no início |

Nenhuma delas falha no code review. Todas aparecem semanas depois.

## 1. Chamado de origem

- Ler o chamado no rastreador do time (Linear, Jira, GitHub Issues — pelo MCP ou pela API que houver):
  título, descrição, estado, labels, projeto.
- Ler os **comentários** e os **anexos**: PRs já ligadas, decisões anteriores, prints.
- Se a descrição estiver vaga sobre o comportamento esperado, listar as ambiguidades **agora** —
  perguntar antes de planejar custa uma pergunta; perguntar depois custa o retrabalho.
- **Gravar no cache da tela**, já que o chamado acabou de ser lido:
  `node {{CLONE}}/ferramentas/linear.mjs gravar $ARGUMENTS '<json>'`. A forma do json está no
  `/quality-fim-trabalho`, passo 1.2 — é o que faz o link e o título aparecerem na barra da tela.
- Identificar quem abriu e para qual cliente, se isso entra na mensagem de commit do time.
- **Chamado que já tem trabalho:** ver as PRs existentes e gravar qual é a comparação certa por repo,
  senão a tela mostra o diff da branch errada (ou vazio, se a PR já foi mesclada):

```bash
cd <projeto> && gh pr list --search "$ARGUMENTS in:title" --state all \
  --json number,state,headRefName,updatedAt,title
node --disable-warning=ExperimentalWarning {{CLONE}}/ferramentas/comparacao.mjs \
  definir $ARGUMENTS <projeto> --pr=<N>
```

  Chamado novo, sem PR nenhuma: `--stage` (branch contra a base observada). Critérios completos no
  `/quality-fim-trabalho`, passo 1.5.

  A decisão para numa linha da tabela `decisoes` do banco de estado, e é essa tabela que a tela lê.
  Editar o `comparacoes.json` à mão **não muda mais nada** — ele só foi lido na primeira importação.
  `comparacao.mjs listar $ARGUMENTS` mostra o que está gravado, e
  `ferramentas/banco.mjs resumo|importacoes|exportar` abre o banco inteiro para conferência.

  O `--disable-warning=ExperimentalWarning` não é enfeite: as ferramentas que abrem o SQLite embutido
  (`comparacao.mjs`, `pontos.mjs`, `banco.mjs`) cospem `ExperimentalWarning` no stderr sem a flag, e
  isso polui a saída de uma rotina que é lida por um agente. **Nunca trocar por `--no-warnings`**, que
  esconderia aviso de verdade.

## 2. Boas práticas que valem aqui

- Ler `.claude/docs/quality-qualidade-de-codigo.md` **inteiro** antes de escrever qualquer linha.
- Ler o `CLAUDE.md` do(s) projeto(s) que a tarefa toca — se os projetos são independentes, o padrão
  de um não vale no outro.
- Anotar no plano quais regras têm risco real nesta tarefa (ex: se vai criar model, a regra de
  comentário dentro da definição; se vai criar enum, a de nada solto fora da classe).

## 3. Política de testes deste repo

Preencher com a política do seu time — é o que o `regras.json` do quality-gate grava, e é como a
checagem de spec novo sabe onde ela vale:

| Repo | Spec novo |
|---|---|
| `<repo onde pode>` | permitido |
| `<repo onde não pode>` | **não** — só ajustar existente |
| outros | conferir se os arquivos irmãos têm spec antes de decidir |

- Rodar `ls` na pasta de spec correspondente e **dizer quantos irmãos têm spec** — já foi esse
  número, e não a regra, que mudou a decisão.
- Registrar no plano: qual teste vai provar a correção, e como ele vai ser verificado com dentes
  (reverter a correção e confirmar que quebra).

## 4. Dados reais no ambiente de teste

Nunca planejar contra o dado que você imagina.

- Se o `.env` do quality-gate não existir, avisar e seguir sem esta etapa — **não** usar string de
  conexão de produção que exista no workspace.
- Listar índices e conferir o tipo dos campos que a tarefa vai filtrar:
  `node {{CLONE}}/ferramentas/indices.mjs <colecao> --indices`
- Se já houver um filtro previsto:
  `node {{CLONE}}/ferramentas/indices.mjs <colecao> '<filtro json>'`
- Perguntas a responder com número, não com adjetivo: o dado existe? quantos? o campo é do tipo que
  o código vai comparar? o volume aguenta a query pensada?

## 5. Sinal no agregador de logs

- Buscar erro relacionado ao fluxo que a tarefa toca **antes** de mexer: se já erra hoje, o
  diagnóstico muda.
- Três armadilhas que já custaram diagnóstico errado, e valem em qualquer ferramenta: a **região
  errada** da conta responde igual a credencial inválida; o nome do serviço no log costuma **não** ser
  o nome do repo; e `env` e `environment` podem ser tags diferentes, com valores diferentes. Anotar
  as do seu time aqui.
- Se o fluxo não emite nada, isso é um achado do plano — não um detalhe.

## 6. Pontos de atenção já registrados

```bash
node --disable-warning=ExperimentalWarning {{CLONE}}/ferramentas/pontos.mjs listar
```

Ler **antes** de planejar. São achados de sessões anteriores, com número e arquivo — e o motivo de
existirem é evitar redescobrir o mesmo problema. Os que valem para este chamado ou projeto entram no
plano; os que já foram resolvidos, tirar com `remover`.

Se durante o levantamento aparecer algo que mudaria uma decisão e não está na lista, registrar agora
(critério e comando no `/quality-fim-trabalho`, passo 4) — não esperar o fim.

## 7. As três perguntas que não têm passo próprio

Os passos 1 a 6 já produziram fato para as perguntas 1 e 2. Estas três não têm comando que as
responda sozinho — e são as que costumam chegar ao fim em branco.

### 7.1 Isso já existe? (#3)

Grep **antes** de escrever, nos repos que a tarefa toca. Os lugares onde a duplicata se esconde estão
em `.claude/docs/quality-qualidade-de-codigo.md`, seção **Estrutura** ("procurar antes de criar") —
usar aquela lista, não a lembrança.

**Buscar contra o remoto, não contra o working tree.** Checkout velho transforma ausência em fato
negativo, e fato negativo ninguém desconfia depois:

```bash
git -C <projeto> fetch --all --prune
git -C <projeto> rev-list --count HEAD..origin/<base>    # quantos commits atrás estou
git -C <projeto> grep -in "<termo>" origin/<base>
```

Já aconteceu: um documento afirmou que um job "não existia" com o checkout local **16 commits e seis
semanas** atrás — o job tinha sido mesclado havia dez dias. Se o repo estiver atrás e não der para
atualizar, dizer isso **junto** com a conclusão.

> `zsh` come o caminho em `git show origin/$ref:arquivo` — `:c` é modificador de expansão. Usar aspas.

No plano vai **o que foi procurado e onde**, não só a conclusão: "não achei" sem o termo buscado não
é verificação, é impressão.

### 7.2 É a casa certa? (#4)

Para **cada** projeto que o plano toca, escrever por que a lógica é dele. Projeto na lista sem
justificativa é o sintoma — o convite é sempre pôr a lógica onde o arquivo já está aberto.

O critério que decide: **quem é dono do dado**, e quem já tem o model, o service e a permissão. Se a
resposta for "aqui é mais fácil", a casa está errada. Quem possui a coleção possui os nomes.

### 7.3 Quem mais precisa saber? (#5)

Levantar **agora**, não no fim: é a única das cinco cujo prazo é de outra pessoa. Permissão pedida no
início chega a tempo; pedida na entrega, segura a entrega.

A tabela é o **molde**; as linhas são do seu time. O que elas têm em comum é o que importa: obrigação
que atravessa repo e **não falha em review**.

| O que | Onde | Armadilha |
|---|---|---|
| rota nova | arquivo de roteamento do gateway | a ordem/prioridade costuma **não** ser sequencial — escolher com Grep |
| permissão ou papel novo | provedor de identidade | criar em **todos** os ambientes, não só no de teste |
| chave nova de texto ou label | migração de tradução | sem ela a tela mostra a chave crua, e nada falha em review |
| ação em lote | classe de permissão | registrar no mapa de **cada visão** em que a ação aparece; só num deixa a ação inerte nas outras, sem erro |
| outras equipes, infra, deploy | nota no chamado | conversa não fica registrada |

O que a tarefa **não** exige, dizer que não exige: lista vazia e lista não levantada são
indistinguíveis depois.

## 8. Plano em `.claude/planos/$ARGUMENTS.md`

Sempre escrever, sempre em md, sempre com estas seções:

```
# <ID> — <título do chamado>
## O que o chamado pede        (em uma frase, palavras do chamado)
## O que eu verifiquei         (fatos com número: ambiente de teste, logs, código existente)
## Volume esperado             (#2 — quantos documentos, e por qual índice a query passa)
## Já existe algo parecido?    (#3 — o que foi procurado e onde, não só a conclusão)
## Projetos tocados            (#4 — e por que a lógica é de cada um: dono do dado, não conveniência)
## Passos                      (numerados, cada um verificável)
## Teste que prova             (e como ele quebra se a correção for revertida)
## Obrigações que atravessam   (#5 — roteamento, permissões, tradução, o que mais o time tiver)
## O que emite sinal           (#1 — e o que não dá para responder depois)
## Dúvidas em aberto           (o que precisa de decisão do usuário)
```

Apresentar o plano e **esperar aprovação** antes de escrever código.

Ao apresentar, dizer **qual das cinco ficou sem resposta** e o que custa começar assim — "não
consegui medir volume, não há acesso ao ambiente de teste" é uma resposta; seção preenchida no chute
não é. Começar mesmo assim é decisão do usuário, não minha.

### Aprovado o plano — a branch, antes da primeira linha

- Nome da branch é **só o ID em maiúsculo**: `ABC-1234`. Sem slug descritivo — é assim que a tela
  reconhece o chamado.
- **Não renomear branch com PR aberta** — a renomeação pela API já **fechou o PR** em vez de
  re-apontar, e o reopen falhou. Nomear certo agora sai de graça.
- A base é a do seu time, e **`origin/HEAD -> main` engana**: se a base for outra, passar `--base`
  explicitamente. O quality-gate descobre a base **observando** para onde as PRs recentes mesclaram.
- Se algum repo seu tem armadilha de checkout (submódulo, `node_modules` versionado, hook local),
  anotar aqui — é o tipo de coisa que custa meia hora na primeira vez e dois minutos depois de escrita.

## Limites

- Não alterar infraestrutura, ambiente de teste ou produção — só leitura; entregar comando pronto.
- Ambiente de teste é somente leitura, sempre.
- Achado fora do escopo do chamado se **relata**, não se implementa.
- **Pergunta de desenho não é ordem de implementar.** "E se a gente fizesse X?", "por que Y é
  necessário?", "isso?" pedem análise: responder, expor o custo dos dois lados, recomendar uma opção
  e **parar**. Vale mesmo quando o conserto é óbvio — o desenho em discussão pode apagar aquele trecho.
- **Spec vem depois da implementação assentar.** Enquanto o desenho muda, spec escrito é trabalho que
  a próxima decisão joga fora. Suíte vermelha temporária é aceitável se **declarada**.

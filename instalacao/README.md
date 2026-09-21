# Instalar

Sem `npm install`. Sem dependência. Só o Node do sistema.

## 1. Clonar dentro do workspace

O projeto descobre os repos olhando a **pasta que o contém**. Então ele mora ao lado deles:

```
seu-workspace/
  quality-gate/     ← aqui
  repo-a/
  repo-b/
```

```bash
cd ~/seu-workspace
git clone https://github.com/recigiorivio/quality-gate.git
```

Se preferir manter o projeto fora do workspace, aponte com `QUALIDADE_WORKSPACE`:

```bash
QUALIDADE_WORKSPACE=~/seu-workspace npm start
```

## 2. Conferir os pré-requisitos

```bash
cd quality-gate
node instalacao/verificar.mjs
```

Ele diz o que falta e o que a falta custa — em vez de você descobrir na tela vazia:

| Nível | O que confere |
|---|---|
| obrigatório | Node **22.5.0+** (lido do `engines`, não chumbado aqui), `git`, `vendor/acorn.mjs`, o workspace existir e ter repos git |
| recomendado | `gh` instalado **e autenticado** (sem ele: nada de PR, base observada nem checks); linters nos repos |
| opcional | `.env` de stage, os gatilhos **deste clone** registrados, a porta 4100 livre |

Sai com código 1 se faltar algo obrigatório, então serve em script.

## 3. Subir

```bash
npm start          # http://localhost:4100
PORT=4200 npm start
```

## 4. Opcional: `.env` para o cartão de índices

Só o cartão **Índices e performance** depende disto. Todo o resto funciona sem.

```bash
cp .env.example .env
```

Leia os comentários do `.env.example`: ele explica quais chaves têm efeito **naquele arquivo** e
quais são do processo. Resumo da armadilha: `PORT` no `.env` **não faz nada**.

## 5. Os gatilhos e o serviço

```bash
node instalacao/gatilhos.mjs          # estado: gatilhos, serviço, tela e rotinas plantadas
node instalacao/gatilhos.mjs --add    # pergunta as duas coisas, uma por vez
node instalacao/gatilhos.mjs --remove # desfaz TUDO deste clone
```

O `--add` pergunta **duas** coisas separadas:

**1. Os gatilhos (recomendado).** Fazem a rotina de fim chegar sozinha quando você fala de commit,
PR ou merge, e derrubam o cache da tela depois de um commit. Mescla só as três entradas **deste**
clone no `<workspace>/.claude/settings.json`, guarda `.bak` antes, e é idempotente. A remoção é por
**caminho**, não por evento: dois clones convivem, e desinstalar um não desliga o do outro.

**2. O LaunchAgent.** É o que mantém a tela no ar. Sem ele nada a sobe sozinha, e `npm start` num
terminal **morre com o terminal** — reboot também derruba. O plist vai para
`~/Library/LaunchAgents/quality-gate.<hash-do-clone>.plist`, com `RunAtLoad` e `KeepAlive`.

Duas coisas nele que quebram em silêncio se você escrever o plist à mão:

- o **`node` por caminho absoluto** — o launchd não resolve nome pelo PATH. E num node de `nvm` o
  caminho carrega a versão: trocar de node exige rodar o `--add` de novo
- o **`PATH` assado** — o padrão do launchd é `/usr/bin:/bin:/usr/sbin:/sbin`, e o `gh` mora em
  `/opt/homebrew/bin`. Sem assar, a tela sobe e perde PR, base observada e checks, sem erro nenhum

Rodar sem terminal interativo responde **não** às duas. `--sim` aceita as duas, `--porta=4200` muda
a porta do serviço.

⚠️ Hook novo só vale na **próxima** sessão do Claude Code — a atual já leu o `settings.json`.

Em qualquer momento, **`/quality-subir-tela`** põe a tela no ar (ou devolve o link, se já estiver).
É um dos markdown plantados, então sai no `--remove` junto com o resto.

O hook **não bloqueia nada** e falha aberto: qualquer erro interno libera a ação. Overhead medido em
comando que não casa: **29 ms**. Para desligar tudo de uma vez, apague a chave `hooks`.

As rotinas são quatro markdown (duas rotinas, as regras de código e o `/quality-subir-tela`) —
editáveis pela aba **Configurações** da própria tela. Vêm em `padroes/`, e a primeira abertura oferece
plantá-las no seu workspace, ou **apontar um `.md` seu** no lugar de cada uma.

Os padrões trazem uma rotina **real**, com o porquê de cada passo, e não um esqueleto vazio. O que é
de um time específico está marcado com `<...>` para você preencher. E os comandos são versionados com
`{{CLONE}}` e `{{TELA}}` no lugar do caminho e da URL: **quem planta reescreve com o caminho real
deste clone e a porta em uso.**

Dois motivos para o caminho não ficar fixo no repo: o clone pode ter qualquer nome, e comando com
pasta errada dentro de uma rotina é pior que nenhum comando — o agente tenta, falha, e a rotina perde
autoridade. Deixar um placeholder para a pessoa preencher tem o mesmo problema ao contrário:
instrução dentro de um bloco de comando é coisa que ninguém executa.

Os nomes levam prefixo `quality-` (`quality-inicio-trabalho.md`, `quality-fim-trabalho.md`,
`quality-qualidade-de-codigo.md`) para conviverem com a rotina que você já tem: sem o prefixo o
destino colidia, a instalação pulava os três e terminava "ok" sem ter entregado nada. Arquivo que já
existe nunca é sobrescrito, nem na instalação nem depois.

## Arquivos locais (todos no `.gitignore`)

Nada do que é do **seu** time mora no código. São quatro arquivos, e nenhum é obrigatório:

| Arquivo | Copie de | Para que serve |
|---|---|---|
| `regras.json` | `regras.example.json` | repos onde **não** se cria spec novo |
| `bases.json` | `bases.example.json` | base de fallback por repo, quando não há PR mesclado para observar |
| `.env` | `.env.example` | consulta de leitura ao banco de stage |
| `LOCAL.md` | — | suas anotações: convenções do time, medições, o que você trocou nas rotinas |

E dois arquivos que a ferramenta escreve sozinha, também ignorados: `gate.log` (disparos do hook) e
`servico.log` (o stderr do LaunchAgent — zerado a cada `--add`, porque `KeepAlive` com servidor em
laço de erro escreve sem teto).

Sem `regras.json` a checagem de spec novo nunca dispara — é o comportamento certo para um projeto
genérico, e o que você provavelmente quer mudar primeiro.

A base de verdade é **observada** (para onde os PRs recentes mesclaram) e escolhida por topologia no
diff. O `bases.json` só entra quando não há PR mesclado para consultar.

## Convenções que o projeto assume

Sem elas ele abre vazio, e nenhuma é configurável hoje:

- **branch = ID do chamado em maiúsculo**, no padrão `ABC-1234`. Branch `feat/...` nunca aparece.
- um chamado é considerado aberto quando **algum repo está com aquela branch em checkout**
- os repos são clones locais **irmãos** do projeto
- o projeto **não faz `git fetch`** — `origin/*` pode estar atrasado

## Antes de rodar contra código de verdade

```bash
npm test
```

128 casos: sobe o servidor numa porta aleatória, bate em todas as rotas, confere a forma das respostas
e o comportamento do cache, roda cada ferramenta de linha de comando, valida o de-para do
`doutrina.json`, e cobre o registro dos gatilhos no `settings.json` e o plist do LaunchAgent.

```bash
node ferramentas/checar-diff.mjs --autoteste
```

42 casos com exemplo do jeito **certo** e do **errado** para cada regra. Se algum falhar, não confie
na saída: uma checagem que acusa o jeito certo ensina a ignorar o aviso. É a regra para mexer nas
regras.

## Depois de algumas semanas

```bash
npm run log
```

Diz quantos disparos do hook mudaram algo. Se a resposta for zero por semanas, o hook virou paisagem
— e a sugestão do próprio comando é desligá-lo.

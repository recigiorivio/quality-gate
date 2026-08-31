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
| obrigatório | Node **20.11+**, `git`, `vendor/acorn.mjs`, o workspace existir e ter repos git |
| recomendado | `gh` instalado **e autenticado** (sem ele: nada de PR, base observada nem checks); linters nos repos |
| opcional | `.env` de stage, o hook registrado, a porta 4100 livre |

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

## 5. Opcional: o hook

Faz a rotina de fim chegar sozinha ao Claude quando você fala de commit, PR ou merge, e derruba o
cache da tela depois de um commit. Sem ele, a tela funciona igual — só não é acionada sozinha.

Em `<workspace>/.claude/settings.json`, trocando o caminho pelo seu:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node /caminho/quality-gate/hook/gate.mjs prompt", "timeout": 20 }] }
    ],
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node /caminho/quality-gate/hook/gate.mjs pretooluse", "timeout": 120 }] }
    ],
    "PostToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node /caminho/quality-gate/hook/gate.mjs posttooluse", "timeout": 20 }] }
    ]
  }
}
```

O hook **não bloqueia nada** e falha aberto: qualquer erro interno libera a ação. Overhead medido em
comando que não casa: **29 ms**. Para desligar, apague a chave `hooks`.

As rotinas que ele injeta são dois markdown em `.claude/commands/` — editáveis pela aba
**Configurações** da própria tela. Elas não vêm neste repo porque descrevem o processo do seu time.

## Arquivos locais (todos no `.gitignore`)

Nada do que é do **seu** time mora no código. São quatro arquivos, e nenhum é obrigatório:

| Arquivo | Copie de | Para que serve |
|---|---|---|
| `regras.json` | `regras.example.json` | repos onde **não** se cria spec novo |
| `bases.json` | `bases.example.json` | base de fallback por repo, quando não há PR mesclado para observar |
| `.env` | `.env.example` | consulta de leitura ao banco de stage |
| `LOCAL.md` | — | suas anotações: convenções do time, medições, onde o hook está |

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

20 casos: sobe o servidor numa porta aleatória, bate em todas as rotas, confere a forma das respostas
e o comportamento do cache, roda cada ferramenta de linha de comando, e valida o de-para do
`doutrina.json`.

```bash
node ferramentas/checar-diff.mjs --autoteste
```

16 casos com exemplo do jeito **certo** e do **errado** para cada regra. Se algum falhar, não confie
na saída: uma checagem que acusa o jeito certo ensina a ignorar o aviso. É a regra para mexer nas
regras.

## Depois de algumas semanas

```bash
npm run log
```

Diz quantos disparos do hook mudaram algo. Se a resposta for zero por semanas, o hook virou paisagem
— e a sugestão do próprio comando é desligá-lo.

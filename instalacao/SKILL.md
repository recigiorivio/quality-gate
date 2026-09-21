---
name: instalar-quality-gate
description: |
  Instala, atualiza ou REMOVE o quality-gate na máquina de quem pediu: confere pré-requisitos, clona
  ao lado dos repositórios, sobe a tela, deixa a primeira abertura perguntar a raiz do workspace e as
  rotinas, e liga os gatilhos no settings.json. Usar quando alguém disser "instale
  https://github.com/recigiorivio/quality-gate", "instala o quality-gate", "configura a tela de
  qualidade aqui", "desinstala o quality-gate", ou abrir este repositório pela primeira vez sem saber
  o que fazer com ele. NÃO é `npm install` — o projeto não tem dependência de runtime.
---

# Instalar o quality-gate

Você está instalando uma **tela local** que confere uma tarefa antes da PR. Ela é um servidor Node
que lê os repositórios git de uma pasta. Não há binário, não há build, e **não há `npm install`**.

Siga os passos na ordem. **Rodar esta rotina duas vezes não pode estragar nada** — em cada passo,
o que já está feito se relata e se pula.

---

## 0. Onde você está

```bash
pwd && ls -d */.git 2>/dev/null | head -5
```

Se você **já está dentro** de um clone do quality-gate (existe `server.mjs` e `instalacao/`), pule
para o passo 3. Se não, siga do 1.

## 1. Escolher a raiz do workspace

**Pergunte à pessoa** qual pasta contém os clones git que ela quer conferir. Não adivinhe — é a
única decisão desta instalação que a máquina não consegue tomar sozinha.

O projeto mora **ao lado** dos repos:

```
<raiz>/
  quality-gate/    ← aqui
  repo-a/
  repo-b/
```

## 2. Clonar

```bash
cd <raiz> && git clone https://github.com/recigiorivio/quality-gate.git
```

Se a pasta já existe, `git -C quality-gate pull --ff-only` em vez de clonar de novo.

## 3. Conferir os pré-requisitos

```bash
cd <raiz>/quality-gate && node instalacao/verificar.mjs
```

Ele não acessa a rede. Leia a saída inteira e **aja em cada `FALTA`**:

| O que falta | O que fazer |
|---|---|
| Node abaixo de 22.5.0 | **entregue o comando e pare** — instalar Node pede `nvm`/homebrew e às vezes `sudo`; não é decisão de agente |
| `git` ausente | idem |
| `gh` ausente | idem |
| `gh` presente mas não autenticado | **peça para a pessoa rodar `gh auth login`** — é fluxo de navegador, você não faz o login |
| workspace sem repo git | provavelmente a raiz do passo 1 está errada; confirme com a pessoa |

⚠️ **Nunca declare a instalação concluída com um `FALTA` obrigatório em pé.** Sem `gh` autenticado,
metade da tela fica vazia — e vazio sem explicação é o defeito que esta ferramenta inteira existe
para perseguir.

## 4. Subir a tela

```bash
npm start
```

Imprime a URL. Se a porta 4100 estiver ocupada, `PORT=4200 npm start`.

⚠️ **Nada sobe a tela sozinho**, e `npm start` num terminal **morre com o terminal** (SIGHUP). Para
ela voltar depois de reboot ou de fechar o terminal, é o LaunchAgent do passo 6. E em qualquer
momento o comando **`/quality-subir-tela`** põe a tela no ar (ou devolve o link, se já estiver).

## 5. A primeira abertura

Abra a URL e **entregue a tela para a pessoa**. Ela ocupa a tela inteira, sem nada carregado atrás:
enquanto a raiz não está confirmada, qualquer repo listado ali seria leitura de uma pasta que ainda
pode ser a errada. Pede duas coisas:

1. **A raiz do workspace** — já vem preenchida com a pasta detectada, e a tela diz quantos repos git
   achou ali. Trocar a raiz grava `QUALIDADE_WORKSPACE` no `.env` e **exige reiniciar** (a raiz é
   lida quando o servidor sobe).
2. **As rotinas** — quatro markdown (as duas rotinas, as regras de código e o
   `/quality-subir-tela`). Em cada um dá para **apontar um `.md` da própria pessoa** no botão
   `escolher .md…`, que é plantado no lugar do padrão. Arquivo que já existe na pasta **nunca** é
   sobrescrito, e os nomes levam prefixo `quality-` justamente para conviverem com a rotina que o
   time já tem.

   Os padrões **não** são um esqueleto vazio: trazem uma rotina real, com o porquê de cada passo. O
   que é de um time específico está marcado com `<...>` para a pessoa preencher. E os comandos vêm com
   `{{CLONE}}`/`{{TELA}}`, que a instalação **reescreve com o caminho e a porta deste clone** — rotina
   plantada com comando que não roda é pior que rotina sem comando.

**A instalação está concluída quando a tela abre e lista os repos.** "O comando terminou sem erro"
não é evidência de nada — é o mesmo erro que esta ferramenta cobra de quem a usa.

## 6. Gatilhos e serviço

```bash
node instalacao/gatilhos.mjs          # só mostra o estado, não grava nada
node instalacao/gatilhos.mjs --add    # pergunta DUAS coisas, uma por vez
```

O `--add` faz duas perguntas separadas, porque são coisas diferentes e quem quer uma não
necessariamente quer a outra:

1. **Instalar os gatilhos de qualidade? (recomendado)** — sem eles os markdown estão no disco e
   **nada os aciona**, e rotina que depende de alguém lembrar de acionar não é acionada. Mescla só
   as três entradas deste clone no `<workspace>/.claude/settings.json`, aditivo e idempotente, com
   `.bak` antes. Se já houver gatilho de **outro** clone, avisa: os dois rodam, e a rotina chega
   duas vezes.
2. **Instalar o LaunchAgent?** — é o que mantém a tela no ar entre reboots e fechamentos de
   terminal. Sem ele, a tela só existe enquanto alguém segura um `npm start`.

Rodar sem terminal interativo responde **não** às duas: é para nenhum agente instalar serviço na
máquina de alguém por conta própria. `--sim` aceita as duas, `--porta=4200` muda a porta do serviço.

⚠️ O hook novo só vale na **próxima** sessão do Claude Code; a atual já leu o `settings.json`.
Diga isso à pessoa, senão ela conclui que não funcionou.

⚠️ Dois detalhes do plist que quebram em silêncio se você o escrever à mão: o `node` precisa de
caminho **absoluto** (o launchd não resolve nome, e num node de `nvm` o caminho carrega a versão —
trocar de node exige rodar o `--add` de novo), e o `PATH` tem de ser **assado** no plist, senão o
`gh` de `/opt/homebrew/bin` desaparece e a tela sobe sem PR, sem base observada e sem checks.

## 7. Deixar a rotina à mão (opcional)

Para a pessoa poder reinstalar, atualizar ou remover sem lembrar da URL:

```bash
mkdir -p ~/.claude/skills/instalar-quality-gate
cp instalacao/SKILL.md ~/.claude/skills/instalar-quality-gate/SKILL.md
```

Uma skill recém-copiada pode só aparecer na **próxima** sessão. Diga isso à pessoa — senão ela
reinicia achando que algo falhou.

---

# Desinstalar

A instalação escreve em três lugares, e cada um sai de um jeito. Faça na ordem, e **confirme com a
pessoa antes do último passo** — clone apagado leva `.env`, `qualidade.db` e as decisões com ele.

```bash
cd <raiz>/quality-gate
node instalacao/gatilhos.mjs --remove
```

Isso desfaz **tudo** o que este clone instalou fora de si mesmo, numa tacada:

- os gatilhos no `settings.json` — **só** os deste clone: gatilho de outro clone fica de pé
- o **LaunchAgent**, descarregado do `launchctl` e o plist apagado de `~/Library/LaunchAgents`
- as quatro rotinas plantadas, com `.bak` de cada uma antes — a pessoa provavelmente editou o texto,
  e apagar edição sem cópia não se desfaz

Depois disso a tela para de subir sozinha. Ele imprime o que sobrou para você decidir:

```bash
rm -rf ~/.claude/skills/instalar-quality-gate   # a skill
rm -rf <raiz>/quality-gate                      # o clone, o .env e o banco de estado
```

Se a pessoa só quer **desligar** o acionamento e manter a tela, o `--remove` é grosso demais: ele
leva o serviço e as rotinas junto. Nesse caso apague à mão as entradas do clone no `settings.json`
(o `--status` mostra quais são) — a tela funciona igual sem hook, só não é acionada sozinha.

---

## O que NÃO fazer

- **`npm install` não é a instalação.** Ele só traz o Playwright do teste de tela.
- **Não escreva por cima de arquivo existente** em `.claude/`. Se já existe, é o processo do time.
- **Não edite o `settings.json` à mão.** Use `instalacao/gatilhos.mjs`: ele mescla só as chaves
  novas, guarda `.bak` e sabe remover exatamente o que pôs. Sobrescrever o arquivo apaga as
  permissões e os hooks de outras ferramentas que a pessoa tem ali.
- **Não importe `server.mjs`** para testar se ele carrega: importar já sobe o servidor. Use
  `node --check server.mjs`.
- **Não rode sonda avulsa sem `QUALIDADE_ESTADO=$(mktemp -d)` na frente** — sem isso ela escreve no
  banco de verdade e apaga a escolha de repos de quem está usando.

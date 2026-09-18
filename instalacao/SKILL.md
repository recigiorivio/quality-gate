---
name: instalar-quality-gate
description: |
  Instala o quality-gate na máquina de quem pediu: confere pré-requisitos, clona ao lado dos
  repositórios, sobe a tela e deixa a primeira abertura perguntar a raiz do workspace e as rotinas.
  Usar quando alguém disser "instale https://github.com/recigiorivio/quality-gate", "instala o
  quality-gate", "configura a tela de qualidade aqui", ou abrir este repositório pela primeira vez
  sem saber o que fazer com ele. NÃO é `npm install` — o projeto não tem dependência de runtime.
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

## 5. A primeira abertura

Abra a URL e **entregue a tela para a pessoa**. Na primeira vez ela pede duas coisas:

1. **A raiz do workspace** — já vem preenchida com a pasta detectada, e a tela diz quantos repos git
   achou ali. Trocar a raiz grava `QUALIDADE_WORKSPACE` no `.env` e **exige reiniciar** (a raiz é
   lida quando o servidor sobe).
2. **As rotinas** — três markdown padrão, genéricos, que a pessoa troca depois pela aba
   Configurações. Arquivo que já existe no workspace **nunca** é sobrescrito.

**A instalação está concluída quando a tela abre e lista os repos.** "O comando terminou sem erro"
não é evidência de nada — é o mesmo erro que esta ferramenta cobra de quem a usa.

## 6. Deixar a rotina à mão (opcional)

Para a pessoa poder reinstalar ou atualizar sem lembrar da URL:

```bash
mkdir -p ~/.claude/skills/instalar-quality-gate
cp instalacao/SKILL.md ~/.claude/skills/instalar-quality-gate/SKILL.md
```

Uma skill recém-copiada pode só aparecer na **próxima** sessão. Diga isso à pessoa — senão ela
reinicia achando que algo falhou.

---

## O que NÃO fazer

- **`npm install` não é a instalação.** Ele só traz o Playwright do teste de tela.
- **Não escreva por cima de arquivo existente** em `.claude/`. Se já existe, é o processo do time.
- **Não mexa no `settings.json` da pessoa** sem ler, mesclar só as chaves novas e gravar. O hook
  (passo opcional do `instalacao/README.md`) é aditivo; sobrescrever o arquivo não é.
- **Não importe `server.mjs`** para testar se ele carrega: importar já sobe o servidor. Use
  `node --check server.mjs`.

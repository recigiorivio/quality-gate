# quality-gate

Tela local que confere a qualidade de uma tarefa antes de abrir a PR: os checks em cima, o diff
antes/depois embaixo. Roda como servidor Node na porta 4100 e lê os repositórios git que estão na
**pasta que contém este projeto**.

## Se te pediram para "instalar" este projeto

Siga **[`instalacao/SKILL.md`](instalacao/SKILL.md)**, os passos na ordem.

⚠️ **Não é `npm install`.** A ferramenta não tem dependência de runtime — `package.json` não tem
`dependencies`, e rodar `npm install` esperando que isso seja a instalação termina com "instalei" e
nada funcionando. (`npm install` só serve para o teste de tela, que traz o Playwright em
`devDependencies`.)

Instalar aqui é: conferir pré-requisitos, clonar ao lado dos repos, subir a tela, responder o que
ela pergunta na primeira abertura e rodar `node instalacao/gatilhos.mjs --add`, que pergunta
separadamente pelos gatilhos e pelo LaunchAgent que mantém a tela no ar.
**Só está instalado quando a tela abre e lista os repos** — e só é *acionado* com os gatilhos no
`settings.json`. `--remove` desfaz os dois.

## O que este projeto exige

| | |
|---|---|
| Node | **≥ 22.5.0** — o estado usa o `node:sqlite` embutido, que não existe antes disso |
| `git` | obrigatório: tudo parte de `git diff` |
| `gh` autenticado | recomendado: sem ele não há PR, base observada nem checks |

`node instalacao/verificar.mjs` responde isso sozinho e sai com código 1 se faltar algo obrigatório.
Ele não acessa a rede, então é seguro rodar antes de qualquer outra coisa.

## Convenções que o projeto assume

Sem elas a tela abre vazia, e vazia é indistinguível de "não há trabalho aberto":

- **branch = ID do chamado em maiúsculo**, no padrão `ABC-1234`. Branch `feat/...` nunca aparece
- um chamado é considerado aberto quando **algum repo está com aquela branch em checkout**
- os repos são clones locais **irmãos** deste projeto (ou a raiz apontada em `QUALIDADE_WORKSPACE`)

## Para trabalhar no código deste projeto

O contrato é o **[`README.md`](README.md)** — ele explica cada decisão e o que foi medido para
chegar nela. Três regras que o repo cobra de si mesmo:

1. **Sem dependência de runtime.** Nada entra em `dependencies`.
2. **Uma checagem só entra depois de um erro que aconteceu de verdade**, e só com exemplo do jeito
   certo e do errado no `autoteste()`, os dois passando. Checagem que acusa o jeito certo ensina a
   pessoa a ignorar o aviso.
3. **Toda sonda avulsa leva `QUALIDADE_ESTADO=$(mktemp -d)` na frente.** Sem isso ela escreve no
   `qualidade.db` de verdade e apaga a escolha de repos de quem está usando — já aconteceu.
   ⚠️ E **não importe `server.mjs` para checar sintaxe**: importar já sobe o servidor. Use
   `node --check server.mjs`.

```bash
npm test        # 142 casos: rotas, respostas, cache, banco, CLIs, gatilhos, serviço e a doutrina
npm run tela    # a tela num navegador de verdade — este pede `npm install`
```

---
description: Regras de código — comentários, estrutura, testes; as que as checagens cobram
---

# Regras de código

Este é o **padrão que veio na instalação**. Troque pela aba **Configurações** da tela — o arquivo é
`.claude/docs/quality-qualidade-de-codigo.md` no seu workspace.

Este documento é o par humano do `doutrina.json`: cada regra aqui aparece lá com a checagem que a
implementa **ou com o motivo de não ter**. O `teste/doutrina.mjs` falha se os dois discordarem — é o
que impede uma regra de ficar metade implementada sem ninguém saber.

## O que a checagem apaga sozinha

Não viram pergunta nem cartão: `node ferramentas/checar-diff.mjs <projeto> --corrigir` resolve.

| Regra | Checagem |
|---|---|
| Nada acima de `class X {` | `comentario-acima-de-class` |
| Dentro de `const definition = {}` de model: nenhum comentário | `comentario-dentro-de-definition` |
| Migration não leva comentário | `comentario-em-migration` |
| Migration não leva `console.log` | `console-log-em-migration` |

## O que a checagem aponta, e você decide

| Regra | Checagem |
|---|---|
| Comentário explicativo no máximo 2 linhas, exceto TODO | `comentario-bloco-longo` |
| Se o arquivo é uma classe, nada solto no topo do módulo | `declaracao-solta-em-arquivo-de-classe` |
| Derivar do enum, nunca repetir o valor | `literal-onde-cabe-enum` |
| Arquivo novo na pasta que o sufixo indica | `arquivo-fora-da-pasta-convencional` |
| Ler o model de outro domínio havendo service dele | `model-de-outro-dominio` |
| Spec novo só onde a política do repo permite | `spec-novo-onde-a-politica-nao-permite` |

Para decisão já tomada, o escape é `// qualidade:ok <nome-da-regra>` na linha ou na anterior.
Existe porque uma regra calibrada errado uma vez faz a pessoa desligar o conjunto inteiro.

## O que nenhuma checagem cobre

Não dá para mecanizar, e por isso está escrito:

- **Chaves em `if`: sempre bloco `{ }`**, nunca inline.
- **Teste tem que ter dentes.** Reverta a correção e confirme que o teste quebra. Teste que passa
  nos dois estados não testa nada — e é pior que nenhum, porque dá confiança.
- **Comentário diz o porquê, não o quê.** O código já diz o que faz. O comentário existe para o que
  não está no código: a medição, o caso que quebrou, a alternativa que foi descartada e por quê.
  Enum, constante e getter não levam comentário.
- **Observabilidade.** Pergunte sempre como esse caminho falha em silêncio. O modo de falha que
  custa caro não é o que estoura — é o que devolve vazio sem dizer nada.

## As que dependem do seu processo

Estas vieram de um time específico e **são exemplo, não regra sua**. Troque pelas do seu:

- chave nova de tradução exige migrate
- rota nova exige entrada no gateway
- ação nova exige classe de permissão em cada visão em que aparece
- role nova exige criação no provedor de identidade, em homologação **e** produção

## Regra para mexer nas checagens

Uma checagem só entra depois de um erro que aconteceu de verdade, e só com exemplo do jeito **certo**
e do **errado** no `autoteste()`, os dois passando. Checagem que acusa o jeito certo ensina a pessoa
a ignorar o aviso — e aí ela ignora os outros também.

---
description: Rotina de fim — o que corrigir e o que conferir antes de entregar
---

# Fim de trabalho

Este é o **padrão que veio na instalação**. Troque pela aba **Configurações** da tela — o arquivo é
`.claude/commands/final-trabalho.md` no seu workspace.

A regra que organiza a rotina: **o que é mecânico se corrige, o que exige julgamento se confere.**
Item mecânico não vira pergunta nem cartão na tela — vira commit.

## 1. Corrigir o mecânico

```bash
node ferramentas/checar-diff.mjs <projeto> --corrigir
```

Apaga o que não exige decidir nada. O que sobrar é julgamento, e aparece na tela.

## 2. Rodar o que o projeto tem

Teste e linter **do projeto**, não um seu. Se o repo não tem suíte, diga isso em voz alta em vez de
deixar em branco — ausência de teste é informação, ausência de menção é silêncio.

## 3. Decidir a comparação de cada repo

Nenhuma regra local acerta qual PR importa quando há várias. Quem decide é você:

```bash
node ferramentas/comparacao.mjs definir <ID> <repo> --pr=<N> --nota="<por que, em uma frase>"
node ferramentas/comparacao.mjs definir <ID> <repo> --stage
```

| Situação | O que gravar |
|---|---|
| uma PR aberta | `--pr=N` |
| uma PR, mesclada | `--pr=N` (a situação vem do estado dela) |
| várias, todas mescladas | `--pr=<a última>` e `--nota` dizendo que as outras já entraram |
| mesclada, mas com commit depois | `--pr=N --aberto` |
| nenhuma PR | `--stage` |

⚠️ `origin/*` pode estar atrasado. Antes de concluir que sobrou trabalho fora do merge, **busque**:
`git -C <repo> fetch --no-tags origin`. Decidir "aberto" sobre um destino velho é o erro mais caro
desta rotina, porque ele congela na tela como se fosse verdade.

## 4. Conferir na tela

Abra a tela e leia os cartões. Um cartão âmbar que você não sabe explicar é trabalho, não ruído.

## 5. Entregar

Commit com o ID do chamado na mensagem, push, e PR contra a base que o repo de fato usa — conferida,
não presumida. Confirme antes de commitar, empurrar ou abrir PR.

## As cinco perguntas de fechamento

- Você **viu** funcionando, ou só viu passar?
- Aguenta o volume de verdade?
- Isso já existia em algum lugar?
- Está na casa certa?
- Quem precisa saber que mudou?

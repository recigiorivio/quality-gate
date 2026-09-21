---
description: Rotina de início — o que conferir antes de planejar ou escrever código
---

# Início de trabalho

Este é o **padrão que veio na instalação**. Ele descreve um processo genérico; o seu time tem
outro. Troque pela aba **Configurações** da tela — o arquivo é `.claude/commands/quality-inicio-trabalho.md`
no seu workspace, e nada aqui é especial.

## 1. Descobrir o que já existe

Antes de investigar qualquer coisa, olhe se ela já foi resolvida:

```bash
git log --oneline -15 -- <arquivo que você vai mexer>
git branch -a --list '*<ID do chamado>*'
```

**Por quê:** horas se perdem investigando defeito já corrigido em outra branch. E `stage` não é
`main` — reproduzir com o código local não descreve o que roda em produção.

## 2. Ler o contexto do chamado

```bash
node ferramentas/contexto.mjs <ID>
```

Sai branch, PR, base observada e checks de cada repo que tem o ID. É o inventário — não refaça
à mão o que ele já levantou.

## 3. Olhar dado de verdade, não o que você imagina

Se a tarefa fala de volume, de índice ou de um campo que pode estar vazio, **meça antes**. Um plano
feito sobre suposição custa mais caro de desfazer do que de conferir.

## 4. Escrever o plano antes do código

Um markdown curto com: o que muda, em quais repos, o que pode quebrar, e como você vai saber que
funcionou. Se não couber em uma página, a tarefa provavelmente são duas.

## 5. As perguntas que abrem a tarefa

- Já existe algo que faz isso? (duplicar é mais caro que achar)
- Em que repo isso deveria morar?
- Como eu vejo funcionando, sem ser pelo teste?
- Aguenta o volume real?
- Quem mais precisa saber que isso mudou?

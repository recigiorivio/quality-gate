---
description: Sobe a tela do quality-gate (ou devolve o link, se ela já estiver no ar)
---

# Subir a tela

A tela do quality-gate é um servidor Node local. Ela **não sobe sozinha** a menos que o LaunchAgent
esteja instalado — e `npm start` num terminal morre junto com o terminal.

Siga na ordem e **pare no primeiro passo que resolver**.

## 1. Ela já está no ar?

```bash
curl -s -o /dev/null -w "%{http_code}\n" --max-time 3 {{TELA}}/
```

`200` → está no ar. Entregue o link e **pare**: {{TELA}}/

## 2. Existe LaunchAgent para este clone?

```bash
node {{CLONE}}/instalacao/gatilhos.mjs
```

A linha `serviço` diz se há agente e se está carregado.

- **instalado mas não carregado** → `launchctl kickstart -k gui/$(id -u)/<rótulo>`
- **não instalado** → ofereça instalar (`node {{CLONE}}/instalacao/gatilhos.mjs --add`), que é o que faz a tela
  voltar sozinha depois de reboot. Se a pessoa não quiser, vá para o passo 3.

## 3. Subir à mão, sem morrer com o terminal

```bash
cd {{CLONE}} && nohup npm start > /dev/null 2>> servico.log &
```

Sem o `nohup`, fechar o terminal derruba a tela.

Porta ocupada por outra coisa? Suba em outra (`PORT=<outra> nohup npm start …`) — e avise a pessoa
que o hook procura a tela em {{TELA}}, então numa porta diferente ele vai achar que ela está fora do
ar e cair para o HTML temporário.

## 4. Confirmar antes de dizer que subiu

```bash
curl -s -o /dev/null -w "%{http_code}\n" --retry 10 --retry-connrefused --retry-delay 1 {{TELA}}/
```

"O comando não deu erro" não é evidência de nada — é o mesmo defeito que esta ferramenta cobra de
quem a usa. Só diga que subiu depois de ver `200`, e entregue o link.

Se não vier `200`, o motivo está em `servico.log`, dentro do clone, nas últimas linhas.

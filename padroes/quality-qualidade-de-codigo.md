# Qualidade de código — as regras já pedidas

> **Padrão que veio na instalação.** As regras são reais: cada uma nasceu de um erro que aconteceu,
> quase sempre depois de alguém violá-la. O que é do seu stack está marcado com `<...>`. Troque pela
> aba **Configurações** da tela.

**Ler antes de escrever código neste workspace.** Cada regra tem o porquê, porque regra sem motivo
vira ritual e é a primeira a ser esquecida.

---

## Comentários

A maior fonte de retrabalho. Em ordem de quanto já custaram:

**Nada acima de `class X {`.** Nem cabeçalho, nem resumo, nem justificativa. Vale mesmo quando o
código vizinho faz isso — o repo tem exemplos, e a regra ganha deles.

> Cabeçalho no topo do **arquivo**, antes dos imports, continua valendo. É outro lugar.

**Dois motivos:** o que se escreve ali é argumentação — por que a alternativa é pior, o histórico da
decisão — e isso já vive na mensagem de commit e na PR. E fica longe da linha que explica.

**Comentário explicativo só no complexo: alvo de uma linha, teto de duas.** Enum, constante, getter,
mapeamento óbvio: nada. Se o comentário descreve *o quê*, apagar — o nome já diz. Reservar para
armadilha de verdade:

- ordem que importa (decidir antes de publicar, senão a resposta é descartada)
- campo com dois significados (o mesmo `id` querendo dizer coisas diferentes na mensagem e no documento)
- formato que quebra do outro lado (data ISO completa onde só se aceita `aaaa-mm-dd`)

**O que nunca vira comentário:** medição ("em 80 contas, 12 alertas…"), histórico da decisão,
justificativa de posicionamento. Vai para a **descrição da PR**, onde envelhece sem enganar ninguém —
número em comentário vira mentira sem aviso. É sempre o achado mais interessante que gera o bloco
maior, e é exatamente ao contrário do que deveria.

> Se algum repo seu **pede** docstring com o porquê e o invariante, por convenção, anotar a exceção
> aqui. A regra acima vale para comentário inline em qualquer lugar.

**Nunca em cima de atribuição de variável ou campo.** Se o valor precisa de explicação, ela vai num
bloco acima do conjunto, não colada em cada linha.

**Dentro da definição de campos de um model: nenhum.** A definição é para bater o olho e ver os
campos; comentário entremeado quebra o alinhamento. O que precisava ser dito vai num bloco único
acima dela.

**Migração não leva comentário nem `console.log`.**

**Exceção: `TODO` pode ser longo** — ele carrega o contexto de quem for implementar.

---

## Estrutura

**Se o arquivo é uma classe, nada solto no topo do módulo.** Nem `const MAPA = {...}`, nem
`const helper = () => {}`. Duas saídas:

| O que é | Onde vai |
|---|---|
| de-para, conjunto de valores do domínio | arquivo próprio na pasta de enums, no padrão do repo |
| função auxiliar | método da própria classe, com `_` na frente se for interno |

Constante solta não tem dono e não é reaproveitável: quando um segundo arquivo precisa dela, alguém
copia.

**Derivar do enum, nunca repetir o valor.** `[faseEnum.A, faseEnum.B]`, não `[3, 4]` — o literal não
acompanha uma renumeração.

**Chaves em `if`: sempre bloco `{ }`, nunca inline.**

**Procurar antes de criar — grep, nunca memória.** Enum, método, service, fila: antes de escrever o
seu, procurar pelo conceito nos repos que a tarefa toca, **no idioma do código e no do time** (os dois).
Os lugares que concentram as duplicatas — preencher com os do seu stack:

| Onde | O que costuma estar lá |
|---|---|
| pasta de enums do repo | o valor de domínio que você ia declarar no topo do arquivo |
| o service do domínio dono do dado | o método de leitura que você ia refazer |
| `<doc de fluxo de filas/eventos>` | produtor e consumidor da fila, e dois enums parecidos numerando a mesma coisa |
| `<arquivo de constantes de coleções/tabelas>` | a constante que pode ter sido renomeada |

Uma auditoria contra 11 repos nasceu de **dois enums parecidos**. "Não achei" sem dizer o termo
buscado não é verificação, é impressão.

**Model de outro domínio não se lê direto.** Antes de acessar o model de um domínio que não é o do
arquivo que você está escrevendo, procurar o service ou comando desse domínio e usar o método que já
existe. Se não existe, o lugar de criar o método é lá, não no chamador.

Por quê: o service do domínio é onde ficam as decisões daquela leitura (projeção, conversão de id, o
que "conta como ativo"); quem lê o model direto refaz essas decisões, e refaz diferente. Caso real:
uma ficha lia a mesma coleção pelo model em três repos, enquanto três services já existiam com a
mesma leitura. O `checar-diff` avisa (`model-de-outro-dominio`): decidir se o service existe é
julgamento, e por isso ele não corrige sozinho.

**Quem possui a coleção possui os nomes.** O enum, o de-para e o status de um dado moram no projeto
dono dele, não no que consome. Lógica escrita na casa mais conveniente — o repo que já estava aberto —
é a que depois precisa ser copiada para a outra.

---

## Consultas

**Filtro por campo dentro de array precisa de recorte indexado no mesmo filtro.** Subcampo de array
quase nunca tem índice, e o banco varre a coleção sem reclamar. Acrescentar um campo indexado do
documento — e escolher o **mais estreito que ainda esteja correto**.

Caso real: dois `updateMany` filtrando só por subcampo, **dentro de um laço por registro**, varreram
por completo duas coleções de 110 mil e 67 mil documentos. Marcar N registros custava 2N varreduras —
e ninguém percebe, porque a operação "funciona".

**Conferir o tipo do campo de recorte em cada coleção antes.** O mesmo conceito troca de tipo entre
coleções, e o tipo errado casa **zero documentos sem erro**. Vale montar a sua tabela aqui: o campo, a
coleção e o tipo real — é a consulta que mais se repete, e a que mais engana de memória.

Antes de aceitar uma query dessas, rodar o plano de execução e procurar varredura completa
(`COLLSCAN` no Mongo, `Seq Scan` no Postgres).

**Atualizar subdocumento e campo da raiz juntos costuma exigir duas operações separadas** — no Mongo,
o positional `$` não combina com campo da raiz na mesma query.

---

## Testes

**Onde pode criar spec novo** — preencher com a política do time, que é o que o `regras.json` grava:

| Repo | Spec novo |
|---|---|
| `<repo onde pode>` | ✅ |
| `<repo onde não pode>` | ❌ só ajustar os que já existem |

Onde não pode, se a lógica alterada não tem spec: rodar a suíte e parar. Se a cobertura for perdida,
**dizer que foi perdida** — criar o arquivo é decisão do usuário.

Ao perguntar, dizer se as irmãs já têm spec. Já foi esse número que mudou a resposta.

**Como rodar, por repo** — anotar o comando real de cada um, com o tempo esperado e o número de
specs. Três armadilhas que valem em geral:

- `127.0.0.1`, nunca `localhost`, quando o serviço está em container: no macOS o nome resolve `::1` e
  o container só escuta IPv4
- cobertura roda os mesmos specs sob instrumentação e **só acrescenta tempo** — não usar na conferência
- `npm test | tail` segura a saída até o processo sair e **parece travado**

⚠️ **Se algum comando de teste do seu workspace derruba banco, escrever aqui em maiúsculas.** Já
aconteceu de uma suíte apagar o banco de desenvolvimento **duas vezes**, a segunda com o aviso lido —
porque a variável que parecia proteger era sobrescrita por outra que substitui a URI inteira. O jeito
seguro é apontar para um banco com nome único a cada corrida.

**Feature que depende de migração se testa rodando a migração** — não inserindo a chave à mão no
banco. A inserção manual prova que a tela lê a chave; não prova que a migração a cria.

**Teste tem que ter dentes.** Antes de entregar, reverter a correção e confirmar que o teste quebra.
Um teste que passa nos dois estados não testa nada — já aconteceu: um parâmetro com valor default
fazia o caso "campo ausente" virar o caso feliz, e o teste passava verde.

**Fixture testa o que você imaginou; o dado real testa o que existe.** Um parser lia a página inteira
como uma linha da tabela, e o fixture não pegava porque foi escrito sem o aninhamento de layout que a
página real tem.

---

## Observabilidade

**O modo de falha que dói é o silencioso.** Mensagem descartada com `nack`, tarefa marcada IGNORADO
esperando resposta que não vem, chave publicada para objeto que não existe: nada disso quebra, e o
custo aparece semanas depois.

Por isso, em todo caminho novo: **isso emite sinal?** Se falhar, alguém descobre sem ir ler o banco?

Duas armadilhas de ferramenta que já custaram diagnóstico errado: o log de aplicação costuma ficar
sob um prefixo de atributos próprio (não na raiz do evento), e **em container o nível do log vem do
stream** — o que for para stderr é lido como erro, mesmo sendo um `warn`.

O que não emite sinal se declara: dizer o que dá para ver, o que não dá para responder depois, e o
custo do que falta.

---

## Documentos

Legíveis por quem **não** acompanhou a conversa que os gerou. Termo definido no primeiro uso, exemplo
concreto, e o porquê. Três blocos curtos em vez de um parágrafo denso.

Documento colaborativo: **só acrescentar**, e só quando pedido. Reler antes de complementar — não
sobrescrever o que o usuário editou.

---

## As cinco perguntas — onde elas moram

Não são regra de código, são rotina: **`/quality-inicio-trabalho`** as trata como levantamento (o que
descobrir antes de escrever) e **`/quality-fim-trabalho`** como conferência (o que mudou desde o plano).

1. dá para ver funcionando? · 2. aguenta o volume? · 3. já existe? · 4. é a casa certa? · 5. quem mais
precisa saber?

A forma de **código** de cada uma está acima, e é ela que as checagens cobram: #1 em
**Observabilidade**; #3 e #4 em **Estrutura** (procurar antes de criar, model de outro domínio, quem
possui a coleção possui os nomes). #2 e #5 não têm forma de código — são levantamento e registro, e
por isso só aparecem nas rotinas.

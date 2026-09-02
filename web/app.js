import { realcar, novoEstado, linguagemDe } from './realce.js';

// Cliente da tela. Arquivo próprio de propósito: quando isto vivia dentro de um template literal,
// qualquer backtick ou ${} em comentário quebrava a página inteira — aconteceu duas vezes.

const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const api = (r,p) => fetch(r + '?' + new URLSearchParams(p)).then(x => x.json());
// `ignorado` = a checagem não se aplica aqui. `indisponível` = ela deveria ter rodado e não rodou.
const ROTULO = {ok:'ok', aviso:'aviso', atencao:'atenção', manual:'julgar',
  ignorado:'ignorado', indisponivel:'indisponível',
  carregando:'consultando…'};

// Esqueleto na forma do que vem, em vez da palavra "carregando": mostra quanto vem e onde, e a tela
// não pula quando o conteúdo entra no lugar.
const esq = (classe = '') => `<div class="esq ${classe}"></div>`;
const esqLinhas = (...larguras) => larguras.map(l => esq(`esq-linha esq-${l}`)).join('');
const esqRepos = n => Array.from({ length: n }, () =>
  `<div class="esq-repo">${esq('esq-nome esq-linha')}${esq('esq-tag')}</div>`).join('');
const esqCodigo = n => `<div class="esq-codigo">${Array.from({ length: n },
  (_, i) => esq(`esq-linha esq-l${(i % 4) + 1}`)).join('')}</div>`;
// Sem abas: 6 a 11 cartões não justificam 4 abas. A lista é única e os grupos só definem a ORDEM.
const ORDEM = [
  'trabalho', 'dados', 'refatoracao', 'atencao'
];
const SEVERIDADE_STATUS = { atencao: 'atencao', aviso: 'aviso', nota: 'manual' };
// O nome da coluna no Linear é livre por time, então o estágio é deduzido por palavra-chave e cai em
// neutro quando não reconhece — cor errada é pior que cor cinza.
const ESTAGIOS = [
  [/cancel|duplicat|descartad/i, 'cancelado'],
  [/block|impedid|bloquead|paus/i, 'bloqueado'],
  [/done|conclu|complet|finaliz|deploy|entregue/i, 'pronto'],
  [/test|review|revis|valida|homolog|qa/i, 'validando'],
  [/progress|andamento|doing|develop|fazendo/i, 'andando'],
  [/refin|grooming|discov/i, 'refinando'],
  [/todo|to do|backlog|triage|aberto|novo/i, 'parado']
];

function estagioDe(status) {
  if (!status) { return 'desconhecido'; }
  for (const [re, nome] of ESTAGIOS) {
    if (re.test(status)) { return nome; }
  }
  return 'desconhecido';
}
const ESQUELETO = window.ESQUELETO || [];
let atual = null;
let geracao = 0;
let visao = 'chamados';
let chamados = [];
let prsDoChamado = [];
let itensDoAtual = { locais: [], remotos: [], pontos: [], lint: [] };

// O pino resume o grupo pelo pior estado dele: a aba precisa dizer se vale abrir antes de abrir.
function pinoDo(itens) {
  if (!itens.length) { return 'neutro'; }
  if (itens.some(i => i.status === 'carregando')) { return 'neutro'; }
  if (itens.some(i => i.status === 'atencao')) { return 'atencao'; }
  if (itens.some(i => i.status === 'aviso')) { return 'aviso'; }
  const neutros = new Set(['manual', 'ignorado', 'indisponivel']);
  if (itens.every(i => neutros.has(i.status))) { return 'neutro'; }
  return 'ok';
}

// Uma lista só, ordenada por grupo. Todo cartão nasce recolhido — quem resume o conjunto é o
// veredito de uma linha acima, então abrir sozinho só empurraria os outros para baixo.
function desenharCartoes(itens) {
  const ordenados = [...itens].sort((a, b) =>
    (ORDEM.indexOf(a.grupo) + 1 || 99) - (ORDEM.indexOf(b.grupo) + 1 || 99));
  document.getElementById('cartoes').innerHTML = ordenados.map(cartao).join('');
}

function cartaoDoLint(r) {
  const linters = (r.linters || []).join(', ');
  const falhas = r.falhas || [];
  if (falhas.length) {
    return { id: 'lint', titulo: 'Lint do projeto', status: 'indisponivel',
      detalhe: `${falhas.map(f => f.nome).join(', ')} não conseguiu rodar`,
      evidencia: falhas.map(f => `${f.nome} em ${f.arquivos} arquivo(s): ${f.motivo}`)
        .concat('estes arquivos NÃO foram conferidos por linter nenhum'),
      grupo: 'trabalho' };
  }
  if (!linters) {
    return { id: 'lint', titulo: 'Lint do projeto', status: 'ignorado',
      detalhe: r.nota || 'nenhum linter configurado neste projeto', evidencia: [], grupo: 'trabalho' };
  }
  if (!r.total) {
    return { id: 'lint', titulo: 'Lint do projeto', status: 'ok',
      detalhe: `${linters} — nada nos arquivos do diff`, evidencia: [], grupo: 'trabalho' };
  }
  return {
    id: 'lint',
    titulo: 'Lint do projeto',
    status: r.erros ? 'atencao' : 'aviso',
    detalhe: `${linters} — ${r.total} achado(s), ${r.erros} erro(s)`,
    evidencia: (r.achados || []).map(a =>
      `${a.arquivo}:${a.linha} [${a.ferramenta}/${a.regra}] ${a.mensagem}`),
    grupo: 'trabalho'
  };
}

function cartao(i) {
  if (i.status === 'carregando') {
    return `<div class="check st-carregando" aria-busy="true">
      <div class="linha1"><span class="tag">${ROTULO[i.status]}</span>
      <span class="titulo">${esc(i.titulo)}</span></div></div>`;
  }
  // Em 4 por linha não cabe título + detalhe na mesma linha, então recolhido mostra só o título e o
  // detalhe desce para o corpo, junto da evidência.
  const corpo = [i.detalhe ? `<p class="det">${esc(i.detalhe)}</p>` : '']
    .concat(i.evidencia.length ? `<ul>${i.evidencia.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : '')
    .join('');
  const resumo = `<span class="tag">${ROTULO[i.status]}</span>
    <span class="titulo">${esc(i.titulo)}</span>
    ${i.pontoId ? `<button class="tirar" title="tirar este ponto da lista"
      onclick="tirarPonto(event,'${i.pontoId}')">×</button>` : ''}`;
  if (!corpo) {
    return `<div class="check st-${i.status} sem-corpo"><div class="linha1">${resumo}</div></div>`;
  }
  return `<details class="check st-${i.status}">
    <summary class="linha1">${resumo}</summary>
    <div class="corpo-check">${corpo}</div>
  </details>`;
}

async function carregarChamados() {
  const r = await api('/api/chamados', {});
  const ocultos = r.ocultos || [];
  chamados = r.lista || [];
  document.getElementById('lista').innerHTML = chamados.map(c => `
    <button class="linha-chamado ${c.chamado === (atual?.chamado) ? 'ativo' : ''}"
            data-c="${c.chamado}" onclick="abrirChamado('${c.chamado}')"
            title="${esc(c.titulo || c.chamado)}">
      <span class="lch-topo">
        <span class="pino-repo p-vazio" title="conferindo…"></span>
        <span class="lch-id">${c.chamado}</span>
        <span class="lch-repos" title="${c.repos.length} repo(s) neste chamado">${c.repos.length}</span>
        <span class="ocultar" title="Tirar do menu" onclick="ocultar(event,'${c.chamado}')">×</span>
      </span>
      ${c.titulo
        ? `<span class="lch-sub">${esc(c.titulo)}</span>`
        : '<span class="lch-sub sem">título não cacheado — rodar /inicio-trabalho</span>'}
    </button>`).join('') || '<p class="vazio">nenhum chamado com branch aberta</p>';
  document.getElementById('ocultos').innerHTML = ocultos.length
    ? `<button class="conta-ocultos" onclick="this.parentNode.classList.toggle('aberto')">
         ${ocultos.length} oculto${ocultos.length > 1 ? 's' : ''}</button>
       <div class="lista-ocultos">${ocultos
         .map(c => `<button onclick="mostrar('${c}')" title="Trazer de volta">${c}</button>`).join('')}</div>`
    : '';
  marcarPinosDaBarra(chamados);
  if (!atual && chamados.length) {
    abrirChamado(chamados[0].chamado);
  }
}

// O pino da linha do chamado é o PIOR dos repos dele: a barra tem que dizer onde olhar antes de
// você abrir. Roda em segundo plano, um repo por vez — o servidor é síncrono no que é local.
async function marcarPinosDaBarra(lista) {
  for (const c of lista) {
    let pior = 'ok';
    let achados = 0;
    for (const r of c.repos) {
      let q;
      try {
        q = await api('/api/qualidade', { chamado: c.chamado, projeto: r.projeto, ref: r.ref || '' });
      } catch {
        continue;
      }
      const itens = q.itens || [];
      achados += itens.filter(i => i.status === 'atencao' || i.status === 'aviso').length;
      const p = pinoDo(itens);
      if (p === 'atencao' || (p === 'aviso' && pior !== 'atencao')) {
        pior = p;
      }
      // Guarda para a área de menu não recalcular ao abrir.
      r.pino = p;
    }
    const pino = document.querySelector(`.linha-chamado[data-c="${c.chamado}"] .pino-repo`);
    if (pino) {
      pino.className = `pino-repo p-${pior}`;
      pino.title = achados ? `${achados} achado(s) neste chamado` : 'nada a corrigir na conferência local';
    }
  }
}

// O chamado abre em duas partes: um cabeçalho fino no topo do conteúdo, e a TRILHA à direita com as
// branches e o Linear. A trilha é recolhível porque o diff é a coisa mais larga do app.
async function abrirChamado(chamado) {
  const c = chamados.find(x => x.chamado === chamado);
  if (!c) { return; }
  for (const b of document.querySelectorAll('.linha-chamado')) {
    b.classList.toggle('ativo', b.dataset.c === chamado);
  }
  const cab = document.getElementById('cabecalho');
  cab.hidden = false;
  cab.innerHTML = `
    <span class="cab-id">${chamado}</span>
    <span class="cab-titulo" id="cab-titulo">${esq('esq-linha esq-l2')}</span>`;

  const trilha = document.getElementById('trilha');
  trilha.hidden = false;
  document.getElementById('trilha-corpo').innerHTML = `
    <div class="tr-secao" id="tr-chamado">
      <div class="tr-titulo">Chamado</div>
      <div class="tr-carregando">${esqLinhas('l1', 'l3', 'l4')}</div>
    </div>
    <div class="tr-secao">
      <div class="tr-titulo">Branches</div>
      <div class="tr-chips" id="tr-chips">${c.repos.map(r => `
        <button class="chip ${r.naBranch ? '' : 'fora'}" data-p="${r.projeto}" data-c="${chamado}"
                data-ref="${r.ref || ''}" onclick="abrir(this)"
                title="${r.naBranch
                  ? `checkout em ${r.branchAtual}`
                  : `tem a branch ${chamado}, mas o checkout local está em ${r.branchAtual} — o diff usa a branch do chamado`}">
          <span class="pino-repo p-${r.pino || 'vazio'}"></span>
          <span class="chip-nome">${r.projeto}</span>
          ${r.sujo ? `<span class="chip-sujo" title="${r.sujo} não commitado(s)">${r.sujo}✎</span>` : ''}
          ${r.naBranch ? '' : `<span class="chip-fora" title="checkout local em ${r.branchAtual}">${r.branchAtual}</span>`}
        </button>`).join('')}</div>
    </div>
    <div class="tr-secao" id="tr-prs">
      <div class="tr-titulo">Pull requests</div>
      <div class="tr-carregando">${esqLinhas('l2', 'l1')}</div>
    </div>
    <div class="tr-pe">
      <button class="tr-recarregar" onclick="recarregarChamado(event,'${chamado}')"
              title="derruba o cache dos ${c.repos.length} repos deste chamado, dos PRs e da lista">
        <span class="tr-cog" aria-hidden="true">⚙</span><span>recarregar</span>
      </button>
    </div>`;
  aplicarRecolhido();

  // Identidade e PRs chegam depois: é rede.
  api('/api/prs', { chamado, projetos: c.repos.map(x => x.projeto).join(',') }).then(r => {
    prsDoChamado = r.prs || [];
    const l = r.linear;
    const titulo = document.getElementById('cab-titulo');
    if (titulo) {
      titulo.innerHTML = l?.titulo ? esc(l.titulo) : '';
    }
    const alvo = document.getElementById('tr-chamado');
    if (alvo) {
      const quando = l?.atualizadoEm ? new Date(l.atualizadoEm).toLocaleDateString('pt-BR') : null;
      alvo.innerHTML = `
        <div class="tr-titulo">Chamado</div>
        <div class="tr-nome">
          <span class="tr-estagio e-${estagioDe(l?.status)}"
                title="${l?.status ? esc(l.status) : 'estágio não sabido — o cache do Linear não tem status'}"></span>
          <span>${esc(l?.titulo || chamado)}</span>
        </div>
        ${l?.url ? `<a class="tr-linear" href="${l.url}" target="_blank" rel="noopener"
            title="abrir ${chamado} no Linear${quando ? ` · dado lido em ${quando}` : ''}">
            <span class="tl-marca">L</span><span>${chamado} no Linear</span><span class="tl-seta">↗</span></a>` : ''}
        ${quando ? `<div class="tr-nota">lido em ${quando}</div>` : ''}`;
    }
    // Todas as abertas, listadas — é o que estava na barra antes da trilha, e é o que se persegue.
    // Mesclada e fechada ficam na aba, que tem largura para o título.
    const prAlvo = document.getElementById('tr-prs');
    if (prAlvo) {
      // Todas, sempre abertas: a trilha é o único lugar onde os PRs aparecem, então esconder
      // atrás de um botão significaria esconder de vez.
      const comPr = prsDoChamado.filter(x => x.temPr);
      const abertas = comPr.filter(x => x.estado === 'OPEN').length;
      const semPr = prsDoChamado.filter(x => x.temPr === false).map(x => x.projeto);
      prAlvo.innerHTML = `
        <div class="tr-titulo">Pull requests
          <span class="tr-conta">${comPr.length}${abertas ? ` · ${abertas} aberta(s)` : ''}</span></div>
        ${comPr.map(x => `
          <a class="tr-pr ${x.doLinear ? 'so-linear' : (x.foraDaVarredura ? 'so-busca' : '')}"
             href="${x.url}" target="_blank" rel="noopener"
             title="${esc(x.titulo || '')}\n\n${esc(x.rotulo)}${x.doLinear ? ' · só o Linear conhece este PR'
               : (x.foraDaVarredura ? ' · fora da varredura local: repo não clonado aqui, ou branch com sufixo' : '')}">
            <span class="tr-pr-estado pr-${x.estado.toLowerCase()}" title="${esc(x.rotulo)}"></span>
            <span class="tr-pr-num">#${x.numero}</span>
            <span class="tr-pr-repo">${esc(x.projeto)}</span>
            <span class="tr-pr-seta">↗</span>
          </a>`).join('') || '<div class="tr-nota">nenhum PR</div>'}
        ${semPr.length ? `<div class="tr-sem-pr">sem PR: ${esc(semPr.join(', '))}</div>` : ''}`;
    }
    pintarAbasDoAtual();
  });

  // Cai no repo com o pior pino: você chega onde está o problema, sem um segundo clique.
  const peso = { atencao: 0, aviso: 1, ok: 2, neutro: 3, vazio: 4 };
  const escolhido = [...c.repos].sort((a, b) => (peso[a.pino] ?? 5) - (peso[b.pino] ?? 5))[0];
  const chip = document.querySelector(`.chip[data-p="${escolhido.projeto}"][data-c="${chamado}"]`);
  if (chip) {
    abrir(chip);
  }
}

function alternarMenu() {
  const recolhido = !document.body.classList.contains('trilha-recolhida');
  document.body.classList.toggle('trilha-recolhida', recolhido);
  try { localStorage.setItem('qualidade:trilha-recolhida', recolhido ? '1' : '0'); } catch { /* aba privada */ }
}

function aplicarRecolhido() {
  let v = '0';
  try { v = localStorage.getItem('qualidade:trilha-recolhida') || '0'; } catch { /* aba privada */ }
  document.body.classList.toggle('trilha-recolhida', v === '1');
}

async function ocultar(evento, chamado) {
  evento.stopPropagation();
  await api('/api/ocultar', { chamado });
  await carregarChamados();
}

async function mostrar(chamado) {
  await api('/api/mostrar', { chamado });
  await carregarChamados();
}

// A prioridade é o diff: o esqueleto e a lista de arquivos entram primeiro, e os cartões preenchem
// conforme chegam. Nada espera por nada.
// Abre um repo. O cabeçalho de identidade não vive mais aqui — está na área de menu do chamado.
// Aqui fica o veredito numa linha, as abas, e o diff.
async function abrir(chip) {
  document.querySelectorAll('.chip').forEach(b => b.classList.remove('ativo'));
  chip.classList.add('ativo');
  atual = { projeto: chip.dataset.p, chamado: chip.dataset.c, ref: chip.dataset.ref || '', botao: chip };
  const token = ++geracao;
  itensDoAtual = { locais: [], remotos: [], pontos: [], lint: [] };
  const alvo = document.getElementById('conteudo');
  alvo.className = '';
  // Clicar numa branch começa do topo: antes a página ficava onde estava, ou saltava para o meio.
  document.querySelector('main').scrollTop = 0;
  alvo.innerHTML = `
    <div class="veredito" id="veredito">${esq('esq-linha esq-l1')}</div>
    <div id="cartoes"></div>
    <h3 class="secao">Diff — antes | depois <span class="carimbo" id="carimbo"></span></h3>
    <div id="arquivos" aria-busy="true">${esqCodigo(4)}</div>`;
  pintarAbasDoAtual(token);

  api('/api/arquivos', { projeto: atual.projeto, ref: atual.ref }).then(d => {
    if (token !== geracao) { return; }
    atual.base = d.base;
    montarArquivos(d);
    marcarCarimbo(d);
  });
  api('/api/qualidade', { chamado: atual.chamado, projeto: atual.projeto, ref: atual.ref }).then(q => {
    if (token !== geracao) { return; }
    itensDoAtual.locais = q.itens;
    pintarAbasDoAtual(token);
  });
  api('/api/lint', { projeto: atual.projeto, ref: atual.ref }).then(r => {
    if (token !== geracao) { return; }
    itensDoAtual.lint = [cartaoDoLint(r)];
    pintarAbasDoAtual(token);
  });
  api('/api/pontos', { chamado: atual.chamado, projeto: atual.projeto }).then(r => {
    if (token !== geracao) { return; }
    itensDoAtual.pontos = (r.pontos || []).map(p => ({
      id: `ponto-${p.id}`,
      pontoId: p.id,
      titulo: p.titulo,
      status: SEVERIDADE_STATUS[p.severidade] || 'manual',
      detalhe: p.detalhe,
      evidencia: [[p.chamado, p.projeto].filter(Boolean).join(' · ') || 'vale para o workspace'],
      grupo: 'atencao'
    }));
    pintarAbasDoAtual(token);
  });
  api('/api/qualidade-remoto', { chamado: atual.chamado, projeto: atual.projeto }).then(r => {
    if (token !== geracao) { return; }
    itensDoAtual.remotos = r.itens;
    pintarAbasDoAtual(token);
    // A base da PR só é conhecida depois da rede. Quando ela chega e muda a comparação, o diff e as
    // checagens desenhados com a topologia estão errados — redesenha os dois com a base certa.
    if (r.baseNova) {
      recarregarComparacao(token);
    }
  });
}

async function recarregarComparacao(token) {
  const [d, q, l] = await Promise.all([
    api('/api/arquivos', { projeto: atual.projeto, ref: atual.ref }),
    api('/api/qualidade', { chamado: atual.chamado, projeto: atual.projeto, ref: atual.ref }),
    api('/api/lint', { projeto: atual.projeto, ref: atual.ref })
  ]);
  if (token !== geracao) { return; }
  atual.base = d.base;
  montarArquivos(d);
  marcarCarimbo(d);
  itensDoAtual.locais = q.itens;
  itensDoAtual.lint = [cartaoDoLint(l)];
  pintarAbasDoAtual(token);
}

function pintarAbasDoAtual(token) {
  if (token !== undefined && token !== geracao) { return; }
  if (!document.getElementById('cartoes')) { return; }
  // Fonte mais específica primeiro: o `find` devolve a primeira, e o resultado real do linter tem
  // que ganhar do placeholder que o `local()` põe enquanto ele não chega.
  const conhecidos = itensDoAtual.lint.concat(itensDoAtual.remotos, itensDoAtual.locais);
  // Cartão condicional (o de mesclagem, por exemplo) tem id fora do ESQUELETO: sem esta linha ele
  // era descartado em silêncio, porque o `map` só percorre o esqueleto.
  // A Cobertura é calculada no passo rápido e só sabe que o linter EXISTE. Se ele não rodou, o
  // crédito que ela deu vira mentira — e quem descobre isso é o cartão do lint, que chega depois.
  const lintItem = itensDoAtual.lint[0];
  const cob = conhecidos.find(i => i.id === 'cobertura');
  if (cob?.creditoLint && lintItem?.status === 'indisponivel') {
    const c = cob.creditoLint;
    cob.status = 'atencao';
    cob.detalhe = `${c.analisados} de ${c.total} arquivo(s) conferidos — o ${c.nomes.join('/')} não rodou`;
    cob.evidencia = [`${c.n} arquivo(s) contavam com o ${c.nomes.join('/')}, que falhou`,
      'ver o cartão do lint — ausência de achado NÃO é aprovação'];
  }
  const fixos = new Set(ESQUELETO.map(e => e.id));
  const todos = ESQUELETO.map(e => conhecidos.find(i => i.id === e.id) || e)
    .concat(conhecidos.filter(i => !fixos.has(i.id)))
    .concat(itensDoAtual.pontos);
  desenharCartoes(todos);
  escreverVeredito(todos);
}

// O mesmo resumo de uma linha que a rotina escreve no fim: contagens e, depois do travessão, o pior
// achado com o lugar. Número sozinho manda a pessoa procurar.
function escreverVeredito(itens) {
  const alvo = document.getElementById('veredito');
  if (!alvo) { return; }
  const conta = st => itens.filter(i => i.status === st).length;
  const atencao = conta('atencao');
  const aviso = conta('aviso');
  const cobertura = itens.find(i => i.id === 'cobertura');
  const fora = (cobertura?.detalhe || '').match(/^(\d+) de (\d+)/);
  const foraN = fora ? Number(fora[2]) - Number(fora[1]) : 0;
  const exts = (cobertura?.evidencia || []).map(e => (e.match(/extensões[^:]*: (.+)$/) || [])[1])
    .filter(Boolean)[0];
  // O cartão de cobertura já está resumido na contagem — usar a evidência dele como "pior achado"
  // repetia a lista de extensões na mesma linha.
  const candidatos = itens.filter(i => i.id !== 'cobertura');
  const pior = candidatos.find(i => i.status === 'atencao') || candidatos.find(i => i.status === 'aviso');
  const partes = [];
  if (atencao || aviso) {
    if (atencao) { partes.push(`<b class="v-atencao">${atencao}</b> atenção`); }
    if (aviso) { partes.push(`<b class="v-aviso">${aviso}</b> aviso`); }
  } else if (itens.some(i => i.status === 'ok')) {
    partes.push('<b>0</b> achados');
  }
  // `fora de cobertura` nunca sai, nem em zero: é o denominador que impede ler "0 achados" como ok.
  partes.push(`<b class="${foraN ? 'v-atencao' : ''}">${foraN}</b> fora de cobertura${exts ? ` (${esc(exts)})` : ''}`);
  const detalhe = pior ? ` — ${esc(pior.evidencia[0] || pior.detalhe).slice(0, 96)}` : '';
  alvo.innerHTML = partes.join(' · ') + detalhe;
}

function marcarCarimbo(d) {
  const c = document.getElementById('carimbo');
  if (!c) { return; }
  const quando = d.desde ? new Date(d.desde).toLocaleTimeString('pt-BR') : '';
  c.textContent = `${d.arquivos.length} arquivo(s) · ${d.via === 'pr' ? '' : 'base '}${d.baseNome || (d.base || '').slice(0, 8)}`
    + (d.mesclado ? (d.comoSoube === 'conteudo' ? ' · mesclado (squash)' : ' · mesclado') : '')
    + (d.ref ? '' : '')
    + (d.doCache ? ` · do cache de ${quando}` : ' · lido agora');
}

// Agrupa os caminhos em árvore e junta corrente de pasta com um único filho num só nível
// (`src/actions/importacao-prontuario.workflow`), senão a árvore fica alta e vazia.
function arvoreDe(arquivos) {
  const raiz = { pastas: new Map(), arquivos: [], adicionadas: 0, removidas: 0 };
  for (const a of arquivos) {
    const partes = a.caminho.split('/');
    const nome = partes.pop();
    let no = raiz;
    no.adicionadas += a.adicionadas;
    no.removidas += a.removidas;
    for (const parte of partes) {
      if (!no.pastas.has(parte)) {
        no.pastas.set(parte, { pastas: new Map(), arquivos: [], adicionadas: 0, removidas: 0 });
      }
      no = no.pastas.get(parte);
      no.adicionadas += a.adicionadas;
      no.removidas += a.removidas;
    }
    no.arquivos.push({ ...a, nome });
  }
  return raiz;
}

function totalDeArquivos(no) {
  let n = no.arquivos.length;
  for (const filho of no.pastas.values()) { n += totalDeArquivos(filho); }
  return n;
}

function comprimir(nome, no) {
  while (no.pastas.size === 1 && !no.arquivos.length) {
    const [unico, filho] = [...no.pastas.entries()][0];
    nome = `${nome}/${unico}`;
    no = filho;
  }
  return [nome, no];
}

function linhaDeArquivo(a, aberto) {
  return `<details class="arq" data-caminho="${esc(a.caminho)}" ${aberto ? 'open' : ''}>
    <summary><b>${esc(a.nome || a.caminho)}</b><span class="badge">${a.estado}</span>
      <span class="mais">+${a.adicionadas}</span><span class="menos">-${a.removidas}</span>
      <span class="dobra"></span></summary>
    <div class="corpo"></div>
  </details>`;
}

function renderNo(no, aberto, nivel) {
  const pastas = [...no.pastas.entries()].map(([nome, filho]) => {
    const [rotulo, alvo] = comprimir(nome, filho);
    const qtd = totalDeArquivos(alvo);
    return `<details class="pasta" ${aberto ? 'open' : ''} style="--nivel:${nivel}">
      <summary><span class="cam">${esc(rotulo)}</span>
        <span class="qtd-arq">${qtd}</span>
        <span class="mais">+${alvo.adicionadas}</span><span class="menos">-${alvo.removidas}</span></summary>
      <div class="dentro">${renderNo(alvo, aberto, nivel + 1)}</div>
    </details>`;
  }).join('');
  const arquivos = no.arquivos
    .sort((a, b) => a.nome.localeCompare(b.nome))
    .map(a => linhaDeArquivo(a, aberto && totalDeArquivosGlobal <= 4))
    .join('');
  return pastas + arquivos;
}

let totalDeArquivosGlobal = 0;

function montarArquivos(d) {
  const caixa = document.getElementById('arquivos');
  if (!caixa) { return; }
  caixa.className = '';
  totalDeArquivosGlobal = d.arquivos.length;
  if (!d.arquivos.length) {
    caixa.innerHTML = d.mesclado
      ? `<p class="aviso"><b>Mesclado.</b> ${d.comoSoube === 'conteudo'
          ? `O commit da branch não está em <code>${esc(d.baseNome || 'base')}</code> (merge por squash),
             mas todo arquivo que ela tocou já está igual lá`
          : `A branch está inteiramente contida em <code>${esc(d.baseNome || 'base')}</code>`}
         — não há nada a revisar.</p>`
      : '<p class="aviso">Nenhuma alteração contra a base.</p>';
    return;
  }
  caixa.innerHTML = renderNo(arvoreDe(d.arquivos), true, 0);
  for (const det of caixa.querySelectorAll('details.arq')) {
    det.addEventListener('toggle', () => { if (det.open) { pintar(det); } });
    if (det.open) { pintar(det); }
  }
}

async function tirarPonto(evento, id) {
  evento.preventDefault();
  evento.stopPropagation();
  await api('/api/ponto-remover', { id });
  abrir(atual.botao);
}

// Recarrega o chamado inteiro: derruba o cache dos N repos dele, dos PRs e da lista, e refaz a
// barra. Antes só dava para recarregar o repo aberto, e os outros ficavam com dado velho.
async function recarregarChamado(evento, chamado) {
  evento.stopPropagation();
  const alvo = evento.target.closest('button') || evento.target;
  alvo.classList.add('girando');
  try {
    // `silencioso`: quem pede e recarrega sozinho não deve receber o aviso de volta.
    await api('/api/invalidar', { chamado, silencioso: 1 });
    await carregarChamados();
    // A barra e os chips foram refeitos: reabrir o chamado é o que reconecta `atual` ao DOM novo.
    abrirChamado(chamado);
    avisarNaTela(`${chamado} recarregado`);
  } finally {
    alvo.classList.remove('girando');
  }
}

async function recarregar() {
  if (!atual) { return; }
  await api('/api/invalidar', { projeto: atual.projeto, silencioso: 1 });
  abrir(atual.botao);
}

// O servidor avisa quando o cache de um projeto cai (o hook de commit dispara isso).
function escutarEventos() {
  const fonte = new EventSource('/api/eventos');
  fonte.onmessage = e => {
    let dados = {};
    try { dados = JSON.parse(e.data); } catch { return; }
    if (dados.tipo !== 'invalidado' || !atual) { return; }
    if (dados.projeto && dados.projeto !== atual.projeto) { return; }
    avisarNaTela(dados.projeto ? `${dados.projeto} mudou — recarregando` : 'cache limpo — recarregando');
    const chamado = atual.chamado;
    carregarChamados().then(() => abrirChamado(chamado));
  };
}

function avisarNaTela(texto) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = texto;
  t.classList.add('vendo');
  clearTimeout(avisarNaTela.tempo);
  avisarNaTela.tempo = setTimeout(() => t.classList.remove('vendo'), 3500);
}

async function pintar(det, completo) {
  const corpo = det.querySelector('.corpo') || det.querySelector('.par');
  if (!corpo || (corpo.dataset.pronto && !completo)) { return; }
  corpo.innerHTML = esqCodigo(6);
  const r = await api('/api/arquivo', {
    projeto: atual.projeto, base: atual.base, ref: atual.ref,
    caminho: det.dataset.caminho, completo: completo ? 1 : 0
  });
  // O estado do realce atravessa as linhas (bloco de comentário, docstring) e zera na lacuna.
  const ling = linguagemDe(det.dataset.caminho);
  const lado = ls => {
    const estado = novoEstado();
    return ls.map(l => {
      if (l.tipo === 'lacuna') {
        estado.emBloco = false;
        return `<div class="l lacuna"><span class="n"></span><code>${esc(l.texto)}</code></div>`;
      }
      const corpo = l.texto ? realcar(l.texto, ling, estado) : '&nbsp;';
      return `<div class="l ${l.tipo}"><span class="n">${l.n ?? ''}</span><code>${corpo}</code></div>`;
    }).join('');
  };
  const novo = document.createElement('div');
  novo.className = 'par';
  novo.dataset.pronto = '1';
  novo.innerHTML = `<div class="col"><h4>antes</h4>${lado(r.antes)}</div>
    <div class="alca" title="arraste para mover a divisão · duplo clique volta ao meio"></div>
    <div class="col"><h4>depois</h4>${lado(r.depois)}</div>`;
  corpo.replaceWith(novo);
  // Só reporta a dobra quando ela de fato escondeu algo: aviso que aparece sempre não informa nada.
  const nota = det.querySelector('.dobra');
  if (nota) {
    nota.innerHTML = r.dobradas
      ? `${r.dobradas} linha(s) iguais dobradas · <button class="inteiro" onclick="verInteiro(this)">ver arquivo inteiro (${r.total})</button>`
      : '';
  }
  // Sem `scrollIntoView` aqui: ele puxava a PÁGINA para o meio do arquivo ao abrir. Com a dobra, a
  // primeira mudança já fica perto do topo das linhas renderizadas, então o salto só desorientava.
}

function verInteiro(botao) {
  pintar(botao.closest('details.arq'), true);
  botao.closest('.dobra').textContent = 'arquivo inteiro';
}

// A divisão é uma proporção única para todos os diffs: arrastar num arquivo vale nos outros, e a
// escolha sobrevive ao recarregamento.
const SPLIT_PADRAO = '50%';

function aplicarSplit(valor) {
  document.documentElement.style.setProperty('--split', valor);
}

function guardarSplit(valor) {
  try { localStorage.setItem('qualidade:split', valor); } catch { /* aba privada */ }
}

function lerSplit() {
  try { return localStorage.getItem('qualidade:split') || SPLIT_PADRAO; } catch { return SPLIT_PADRAO; }
}

function ligarArrasto() {
  let alvo = null;
  document.addEventListener('mousedown', e => {
    const alca = e.target.closest('.alca');
    if (!alca) { return; }
    e.preventDefault();
    alvo = alca.closest('.par');
    alca.classList.add('arrastando');
    document.body.classList.add('arrastando');
  });
  document.addEventListener('mousemove', e => {
    if (!alvo) { return; }
    const caixa = alvo.getBoundingClientRect();
    const pct = Math.min(85, Math.max(15, ((e.clientX - caixa.left) / caixa.width) * 100));
    aplicarSplit(`${pct.toFixed(1)}%`);
  });
  document.addEventListener('mouseup', () => {
    if (!alvo) { return; }
    alvo = null;
    document.querySelectorAll('.alca.arrastando').forEach(a => a.classList.remove('arrastando'));
    document.body.classList.remove('arrastando');
    guardarSplit(document.documentElement.style.getPropertyValue('--split') || SPLIT_PADRAO);
  });
  document.addEventListener('dblclick', e => {
    if (!e.target.closest('.alca')) { return; }
    aplicarSplit(SPLIT_PADRAO);
    guardarSplit(SPLIT_PADRAO);
  });
}

aplicarSplit(lerSplit());
ligarArrasto();
carregarChamados();
escutarEventos();

// ---------- as duas seções da barra ----------

function trocarVisao(qual) {
  visao = qual;
  const emConfig = qual === 'config';
  document.getElementById('painel-chamados').hidden = emConfig;
  document.getElementById('painel-config').hidden = !emConfig;
  document.getElementById('titulo-barra').innerHTML = emConfig
    ? '<span class="mago" aria-hidden="true">⚙</span><span>Configurações</span>'
    : '<span class="mago" aria-hidden="true">🧙</span><span>Magias do Mago</span>';
  document.getElementById('btn-config').classList.toggle('ativa', emConfig);
  document.getElementById('cabecalho').hidden = emConfig;
  document.getElementById('trilha').hidden = emConfig;
  if (emConfig) {
    carregarConfigs();
  } else {
    const alvo = document.getElementById('conteudo');
    alvo.className = 'aviso';
    alvo.innerHTML = 'Escolha um chamado à esquerda.';
    atual = null;
    if (chamados.length) {
      abrirChamado(chamados[0].chamado);
    }
  }
}

async function carregarConfigs() {
  const r = await api('/api/configs', {});
  document.getElementById('painel-config').innerHTML = (r.configs || []).map(c => `
    <button class="item-config" data-k="${c.chave}" onclick="abrirConfig('${c.chave}')">
      <span class="rot">${esc(c.rotulo)}</span>
      <span class="res">${esc(c.resumo)}</span>
      <span class="cam">${esc(c.caminho)}</span>
    </button>`).join('');
  const primeiro = document.querySelector('.item-config');
  if (primeiro && !document.querySelector('.item-config.ativo')) {
    abrirConfig(primeiro.dataset.k);
  }
}

// Edição do markdown cru, não de um formulário: o arquivo é a instrução que eu leio, e um formulário
// só saberia representar os campos que alguém previu.
async function abrirConfig(chave) {
  document.querySelectorAll('.item-config').forEach(b => b.classList.toggle('ativo', b.dataset.k === chave));
  const alvo = document.getElementById('conteudo');
  alvo.className = '';
  alvo.innerHTML = `<div style="padding:6px 0">${esq('esq-titulo')}${esqLinhas('l1','l3','l2','l4')}</div>`;
  const c = await api('/api/config', { chave });
  if (c.erro) {
    alvo.innerHTML = `<p class="aviso">erro: ${esc(c.erro)}</p>`;
    return;
  }
  alvo.innerHTML = `
    <header>
      <h2>${esc(c.rotulo)}</h2>
      <span class="carimbo">${esc(c.caminho)}</span>
      <button class="recarregar" onclick="salvarConfig('${chave}')">salvar</button>
      <span class="selo pr-carregando" id="estado-config">sem alteração</span>
    </header>
    <p class="dica">Editar o markdown direto. O que estiver aqui é o que eu sigo nas rotinas
      <code>/inicio-trabalho</code> e <code>/final-trabalho</code> — a de fim é injetada no meu
      contexto automaticamente quando você fala de commit, PR ou merge.</p>
    <textarea id="editor" spellcheck="false">${esc(c.conteudo)}</textarea>`;
  const editor = document.getElementById('editor');
  const estado = document.getElementById('estado-config');
  editor.addEventListener('input', () => {
    estado.className = 'selo pr-sem-pr';
    estado.textContent = 'não salvo';
  });
  editor.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      salvarConfig(chave);
    }
  });
}

async function salvarConfig(chave) {
  const editor = document.getElementById('editor');
  const estado = document.getElementById('estado-config');
  if (!editor) { return; }
  estado.className = 'selo pr-carregando';
  estado.textContent = 'salvando…';
  const resposta = await fetch('/api/config-salvar', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chave, conteudo: editor.value })
  }).then(r => r.json()).catch(e => ({ erro: e.message }));
  if (resposta.erro) {
    estado.className = 'selo pr-sem-pr';
    estado.textContent = `erro: ${resposta.erro}`;
    return;
  }
  estado.className = 'selo pr-mergeado';
  estado.textContent = `salvo às ${new Date(resposta.quando).toLocaleTimeString('pt-BR')}`;
  avisarNaTela(`${chave} salvo · backup em .bak`);
}

// Em módulo nada é global, e os onclick do HTML gerado precisam alcançar estas funções.
Object.assign(window, {
  abrir, abrirChamado, alternarMenu, pintar, verInteiro,
  recarregar, recarregarChamado, ocultar, mostrar, tirarPonto,
  trocarVisao, abrirConfig, salvarConfig
});
// `visao` é lida pelo onclick da engrenagem.
Object.defineProperty(window, 'visao', { get: () => visao });

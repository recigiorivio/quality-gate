import { realcar, novoEstado, linguagemDe } from './realce.js';

// Cliente da tela. Arquivo próprio de propósito: quando isto vivia dentro de um template literal,
// qualquer backtick ou ${} em comentário quebrava a página inteira — aconteceu duas vezes.

const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const api = (r,p) => fetch(r + '?' + new URLSearchParams(p)).then(x => x.json());
const ROTULO = {ok:'ok', aviso:'aviso', atencao:'atenção', manual:'julgar', indisponivel:'indisponível',
  carregando:'consultando…'};

// Esqueleto na forma do que vem, em vez da palavra "carregando": mostra quanto vem e onde, e a tela
// não pula quando o conteúdo entra no lugar.
const esq = (classe = '') => `<div class="esq ${classe}"></div>`;
const esqLinhas = (...larguras) => larguras.map(l => esq(`esq-linha esq-${l}`)).join('');
const esqRepos = n => Array.from({ length: n }, () =>
  `<div class="esq-repo">${esq('esq-nome esq-linha')}${esq('esq-tag')}</div>`).join('');
const esqCodigo = n => `<div class="esq-codigo">${Array.from({ length: n },
  (_, i) => esq(`esq-linha esq-l${(i % 4) + 1}`)).join('')}</div>`;
const GRUPOS = [
  { id:'trabalho', rotulo:'Chamado, testes e lint' },
  { id:'dados', rotulo:'Dados e performance' },
  { id:'refatoracao', rotulo:'Refatoração' },
  { id:'atencao', rotulo:'Pontos de atenção da IA' }
];
const SEVERIDADE_STATUS = { atencao: 'atencao', aviso: 'aviso', nota: 'manual' };
const ESQUELETO = window.ESQUELETO || [];
let atual = null;
let abaAtiva = null;
let geracao = 0;
let visao = 'chamados';

// O pino resume o grupo pelo pior estado dele: a aba precisa dizer se vale abrir antes de abrir.
function pinoDo(itens) {
  if (!itens.length) { return 'neutro'; }
  if (itens.some(i => i.status === 'carregando')) { return 'neutro'; }
  if (itens.some(i => i.status === 'atencao')) { return 'atencao'; }
  if (itens.some(i => i.status === 'aviso')) { return 'aviso'; }
  if (itens.every(i => i.status === 'manual' || i.status === 'indisponivel')) { return 'neutro'; }
  return 'ok';
}

function desenharAbas(itens) {
  const porGrupo = g => itens.filter(i => i.grupo === g);
  if (!abaAtiva) {
    const comAtencao = GRUPOS.find(g => porGrupo(g.id).some(i => i.status === 'atencao'));
    abaAtiva = (comAtencao || GRUPOS[0]).id;
  }
  document.getElementById('abas').innerHTML = GRUPOS.map(g => {
    const seus = porGrupo(g.id);
    const conta = seus.filter(i => i.status === 'atencao' || i.status === 'aviso').length;
    return `<button class="${g.id === abaAtiva ? 'ativa' : ''}" onclick="trocarAba('${g.id}')">
      <span class="pino p-${pinoDo(seus)}"></span>${g.rotulo}${conta ? `<span class="conta">${conta}</span>` : ''}</button>`;
  }).join('');
  document.getElementById('paineis').innerHTML = GRUPOS.map(g =>
    `<div class="painel ${g.id === abaAtiva ? 'ativo' : ''}" data-g="${g.id}">
      ${porGrupo(g.id).map(cartao).join('') || '<p class="aviso">nada neste grupo</p>'}</div>`).join('');
}

function trocarAba(id) {
  abaAtiva = id;
  for (const b of document.querySelectorAll('.abas button')) { b.classList.remove('ativa'); }
  document.querySelectorAll('.abas button')[GRUPOS.findIndex(g => g.id === id)].classList.add('ativa');
  for (const p of document.querySelectorAll('.painel')) { p.classList.toggle('ativo', p.dataset.g === id); }
}

// O cartão do lint diz QUAL linter rodou: é o do projeto, não um meu, e isso importa para confiar.
function cartaoDoLint(r) {
  const linters = (r.linters || []).join(', ');
  if (!linters) {
    return { id: 'lint', titulo: 'Lint do projeto', status: 'indisponivel',
      detalhe: r.nota || 'nenhum linter configurado', evidencia: [], grupo: 'trabalho' };
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
      <div class="topo"><span class="titulo">${esc(i.titulo)}</span></div>
      ${esqLinhas('l1', 'l2')}
    </div>`;
  }
  return `<div class="check st-${i.status}">
    <div class="topo"><span class="titulo">${esc(i.titulo)}</span>
      ${i.pontoId ? `<button class="tirar" title="tirar este ponto da lista"
        onclick="tirarPonto('${i.pontoId}')">×</button>` : ''}
      <span class="tag">${ROTULO[i.status]}</span></div>
    ${i.detalhe ? `<div class="detalhe">${esc(i.detalhe)}</div>` : ''}
    ${i.evidencia.length ? `<ul>${i.evidencia.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

async function carregarChamados() {
  const r = await api('/api/chamados', {});
  const ocultos = r.ocultos || [];
  document.getElementById('lista').innerHTML = (r.lista || []).map(c => `
    <div class="chamado" data-c="${c.chamado}">
      <button onclick="this.parentNode.classList.toggle('aberto')">
        <span>${c.chamado}</span><span class="qtd">${c.repos.length} repo${c.repos.length>1?'s':''}</span>
        <span class="recarregar-chamado" title="recarregar todos os ${c.repos.length} repos deste chamado"
          onclick="recarregarChamado(event,'${c.chamado}')">↻</span>
        <span class="ocultar" title="Tirar do menu" onclick="ocultar(event,'${c.chamado}')">×</span>
      </button>
      <div class="repos">${c.repos.map(r => `
        <button data-p="${r.projeto}" data-c="${c.chamado}" data-ref="${r.ref || ''}"
          class="${r.naBranch ? '' : 'fora'}" onclick="abrir(this)">
          <span class="pino-repo p-vazio" title="conferindo…"></span>
          <span class="nome-repo" title="${r.projeto}">${r.projeto}</span>
          ${r.sujo ? `<span class="sujo" title="${r.sujo} arquivo(s) alterado(s) e não commitado(s)">${r.sujo} ✎</span>` : ''}
          <span class="branch-tag ${r.naBranch ? '' : 'difere'}" title="${r.naBranch
            ? `Checkout local em ${r.branchAtual} — a mesma branch do chamado.`
            : `Checkout local em ${r.branchAtual}, mas o repo tem a branch ${c.chamado} e participa dele. O diff e a análise usam a branch do chamado, não o checkout. Nada a ver com o estado da PR.`}">${r.branchAtual}</span>
        </button>`).join('')}
        <div class="prs" data-c="${c.chamado}"></div>
      </div>
    </div>`).join('') || 'nenhum chamado com branch aberta';
  document.getElementById('ocultos').innerHTML = ocultos.length
    ? `<button class="conta-ocultos" onclick="this.parentNode.classList.toggle('aberto')">
         ${ocultos.length} oculto${ocultos.length > 1 ? 's' : ''}</button>
       <div class="lista-ocultos">${ocultos
         .map(c => `<button onclick="mostrar('${c}')" title="Trazer de volta">${c}</button>`).join('')}</div>`
    : '';
  const primeiro = document.querySelector('.chamado');
  if (primeiro) { primeiro.classList.add('aberto'); }
  marcarPinosDoMenu(r.lista || []);
  listarPrs(r.lista || []);
}

// Os PRs do chamado, em paralelo (0,7 s para 7 repos). Abrem em aba nova: sair da tela para ver a PR
// e perder o estado da conferência era o caminho mais provável.
async function listarPrs(chamados) {
  for (const c of chamados) {
    const caixa = document.querySelector(`.prs[data-c="${c.chamado}"]`);
    if (!caixa) {
      continue;
    }
    caixa.innerHTML = `<div class="prs-titulo">Pull requests</div>
      <div class="prs-carregando" aria-busy="true" aria-label="consultando pull requests">
        ${esqRepos(Math.min(c.repos.length, 5))}</div>`;
    let r;
    try {
      r = await api('/api/prs', { chamado: c.chamado, projetos: c.repos.map(x => x.projeto).join(',') });
    } catch {
      caixa.innerHTML = '';
      continue;
    }
    const lista = r.prs || [];
    const comPr = lista.filter(x => x.temPr);
    const semPr = lista.filter(x => x.temPr === false);
    caixa.innerHTML = `
      <div class="prs-titulo">Pull requests</div>
      ${comPr.map(x => `
        <a class="pr-link pr-${x.estado.toLowerCase()}" href="${x.url}" target="_blank" rel="noopener"
           title="${esc(x.titulo || '')}">
          <span class="pr-num">#${x.numero}</span>
          <span class="pr-repo">${esc(x.projeto)}</span>
          <span class="pr-estado">${esc(x.rotulo)}</span>
        </a>`).join('')}
      ${semPr.length ? `<div class="pr-falta">sem PR: ${semPr.map(x => esc(x.projeto)).join(', ')}</div>` : ''}`;
  }
}

// O pino do menu diz onde há achado, que é a pergunta que a barra deve responder. Roda em segundo
// plano e um repo por vez: o servidor é síncrono, disparar tudo junto só faz fila.
async function marcarPinosDoMenu(chamados) {
  const alvos = chamados.flatMap(c => c.repos.map(r => ({ chamado: c.chamado, projeto: r.projeto, ref: r.ref || '' })));
  for (const { chamado, projeto, ref } of alvos) {
    let q;
    try {
      q = await api('/api/qualidade', { chamado, projeto, ref });
    } catch {
      continue;
    }
    const botao = document.querySelector(`.repos button[data-p="${projeto}"][data-c="${chamado}"]`);
    const pino = botao?.querySelector('.pino-repo');
    if (!pino) {
      continue;
    }
    const itens = q.itens || [];
    const estado = pinoDo(itens);
    const contagem = itens.filter(i => i.status === 'atencao' || i.status === 'aviso').length;
    pino.className = `pino-repo p-${estado}`;
    pino.title = contagem
      ? `${contagem} achado(s) na conferência deste repo`
      : 'nada a corrigir na conferência local deste repo';
  }
}

// Some do menu, nao do disco: a branch continua la e o chamado volta com um clique. Por isso o
// nome fica visivel no rodape em vez de virar uma lista que so o arquivo conhece.
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
async function abrir(botao, manterAba) {
  document.querySelectorAll('.repos button').forEach(b => b.classList.remove('ativo'));
  botao.classList.add('ativo');
  atual = { projeto: botao.dataset.p, chamado: botao.dataset.c, ref: botao.dataset.ref || '', botao };
  if (!manterAba) { abaAtiva = null; }
  const token = ++geracao;
  const alvo = document.getElementById('conteudo');
  alvo.className = '';
  alvo.innerHTML = `
    <header>
      <h2>${esc(atual.chamado)} · ${esc(atual.projeto)}</h2>
      ${atual.ref ? `<span class="fora-aviso" title="o diff é da branch do chamado, não do checkout atual">diff de ${esc(atual.ref)}</span>` : ''}
      <span class="carimbo" id="carimbo"></span>
      <button class="recarregar" onclick="recarregar()">recarregar</button>
      <span class="selo pr-carregando" id="selo-pr" aria-busy="true">${esq('esq-pilula')}</span>
    </header>
    <div class="abas" id="abas"></div>
    <div id="paineis"></div>
    <h3 class="secao">Diff — antes | depois</h3>
    <div id="arquivos" aria-busy="true">${esqCodigo(4)}</div>`;

  let locais = [];
  let remotos = [];
  let pontos = [];
  let lintado = [];
  const pintarAbas = () => {
    if (token !== geracao) { return; }
    // Fonte mais específica primeiro: o `find` devolve a primeira, e o resultado real do linter tem
    // que ganhar do placeholder que o `local()` põe enquanto ele não chega.
    const conhecidos = lintado.concat(remotos, locais);
    desenharAbas(ESQUELETO.map(e => conhecidos.find(i => i.id === e.id) || e).concat(pontos));
  };
  pintarAbas();

  api('/api/arquivos', { projeto: atual.projeto, ref: atual.ref }).then(d => {
    if (token !== geracao) { return; }
    atual.base = d.base;
    montarArquivos(d);
    marcarCarimbo(d);
  });
  api('/api/qualidade', { chamado: atual.chamado, projeto: atual.projeto, ref: atual.ref }).then(q => {
    if (token !== geracao) { return; }
    locais = q.itens;
    pintarAbas();
  });
  api('/api/lint', { projeto: atual.projeto, ref: atual.ref }).then(r => {
    if (token !== geracao) { return; }
    lintado = [cartaoDoLint(r)];
    pintarAbas();
  });
  api('/api/pontos', { chamado: atual.chamado, projeto: atual.projeto }).then(r => {
    if (token !== geracao) { return; }
    pontos = (r.pontos || []).map(p => ({
      id: `ponto-${p.id}`,
      pontoId: p.id,
      titulo: p.titulo,
      status: SEVERIDADE_STATUS[p.severidade] || 'manual',
      detalhe: p.detalhe,
      evidencia: [[p.chamado, p.projeto].filter(Boolean).join(' · ') || 'vale para o workspace'],
      grupo: 'atencao'
    }));
    pintarAbas();
  });
  api('/api/qualidade-remoto', { chamado: atual.chamado, projeto: atual.projeto }).then(r => {
    if (token !== geracao) { return; }
    remotos = r.itens;
    marcarPr(r);
    pintarAbas();
  });
}

function marcarPr(r) {
  const selo = document.getElementById('selo-pr');
  if (!selo) { return; }
  selo.className = `selo pr-${r.prEstado || 'sem-pr'}`;
  selo.textContent = r.prRotulo || 'sem PR';
  selo.onclick = r.prUrl ? () => window.open(r.prUrl, '_blank') : null;
  selo.style.cursor = r.prUrl ? 'pointer' : 'default';
  selo.title = r.prUrl || '';
}

function marcarCarimbo(d) {
  const c = document.getElementById('carimbo');
  if (!c) { return; }
  const quando = d.desde ? new Date(d.desde).toLocaleTimeString('pt-BR') : '';
  c.textContent = `${d.arquivos.length} arquivo(s) · base ${d.baseNome || (d.base || '').slice(0, 8)}`
    + (d.mesclado ? ' · mesclado' : '')
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
      ? `<p class="aviso"><b>Mesclado.</b> A branch está inteiramente contida em
         <code>${esc(d.baseNome || 'base')}</code> — não há nada a revisar.</p>`
      : '<p class="aviso">Nenhuma alteração contra a base.</p>';
    return;
  }
  caixa.innerHTML = renderNo(arvoreDe(d.arquivos), true, 0);
  for (const det of caixa.querySelectorAll('details.arq')) {
    det.addEventListener('toggle', () => { if (det.open) { pintar(det); } });
    if (det.open) { pintar(det); }
  }
}

async function tirarPonto(id) {
  await api('/api/ponto-remover', { id });
  abrir(atual.botao, true);
}

// Recarrega o chamado inteiro: derruba o cache dos N repos dele, dos PRs e da lista, e refaz a
// barra. Antes só dava para recarregar o repo aberto, e os outros ficavam com dado velho.
async function recarregarChamado(evento, chamado) {
  evento.stopPropagation();
  const alvo = evento.target;
  alvo.classList.add('girando');
  try {
    // `silencioso`: quem pede e recarrega sozinho não deve receber o aviso de volta.
    await api('/api/invalidar', { chamado, silencioso: 1 });
    await carregarChamados();
    if (atual && atual.chamado === chamado) {
      const botao = document.querySelector(
        `.repos button[data-p="${atual.projeto}"][data-c="${chamado}"]`);
      if (botao) {
        abrir(botao, true);
      }
    }
    avisarNaTela(`${chamado} recarregado`);
  } finally {
    alvo.classList.remove('girando');
  }
}

async function recarregar() {
  if (!atual) { return; }
  await api('/api/invalidar', { projeto: atual.projeto, silencioso: 1 });
  abrir(atual.botao, true);
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
    abrir(atual.botao, true);
    carregarChamados();
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
  const primeira = novo.querySelector('.l.rem, .l.add');
  if (primeira && !completo) { primeira.scrollIntoView({ block: 'center' }); }
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
  for (const b of document.querySelectorAll('#nav button')) {
    b.classList.toggle('ativa', b.dataset.v === qual);
  }
  document.getElementById('painel-chamados').hidden = qual !== 'chamados';
  document.getElementById('painel-config').hidden = qual !== 'config';
  if (qual === 'config') {
    carregarConfigs();
  } else {
    document.getElementById('conteudo').innerHTML = '<p class="aviso">Escolha um repo à esquerda.</p>';
    document.getElementById('conteudo').className = '';
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
  abrir, trocarAba, pintar, verInteiro, recarregar, recarregarChamado, ocultar, mostrar, tirarPonto,
  trocarVisao, abrirConfig, salvarConfig
});

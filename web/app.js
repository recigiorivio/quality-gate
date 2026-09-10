import { realcar, novoEstado, linguagemDe } from './realce.js';
import { mdParaHtml } from './markdown.js';

// Cliente da tela. Arquivo próprio de propósito: quando isto vivia dentro de um template literal,
// qualquer backtick ou ${} em comentário quebrava a página inteira — aconteceu duas vezes.

const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
// Um indicador PRINCIPAL de carga, em vez de só esqueletos espalhados: barra fina no topo enquanto
// houver pedido em voo, e o nome do que ainda falta. Os esqueletos dizem ONDE vai entrar conteúdo;
// a barra diz SE a tela ainda está trabalhando — sem ela, com 5 pedidos em paralelo, não dava para
// saber se o "resolvido" que apareceu era final ou se ainda vinha coisa.
// `null` = conta na barra, mas não no texto: arquivo aberto e pontos são rápidos e só poluem.
const NOME_DA_ROTA = {
  '/api/chamados': 'chamados', '/api/arquivos': 'diff', '/api/arquivo': null,
  '/api/qualidade': 'checagens', '/api/qualidade-remoto': 'GitHub', '/api/lint': 'lint',
  '/api/pontos': null, '/api/prs': 'PRs', '/api/invalidar': null
};
const emVoo = new Map();
let barraTimer = null;

function marcarCarga() {
  const barra = document.getElementById('carga');
  const texto = document.getElementById('carga-texto');
  if (!barra) { return; }
  const nomes = [...new Set([...emVoo.values()].filter(Boolean))];
  if (emVoo.size) {
    clearTimeout(barraTimer);
    barra.classList.add('ativa');
    barra.classList.remove('fim');
    if (texto) {
      const visiveis = nomes.slice(0, 3).join(' · ') + (nomes.length > 3 ? ` +${nomes.length - 3}` : '');
      texto.textContent = nomes.length ? `carregando ${visiveis}` : 'carregando…';
    }
  } else {
    // Fecha a barra até o fim antes de sumir: barra que desaparece a 70% parece que quebrou.
    barra.classList.add('fim');
    barraTimer = setTimeout(() => { barra.classList.remove('ativa', 'fim'); }, 420);
    if (texto) { texto.textContent = ''; }
  }
}

const api = (r, p) => {
  const id = Symbol(r);
  emVoo.set(id, r in NOME_DA_ROTA ? NOME_DA_ROTA[r] : r.replace('/api/', ''));
  marcarCarga();
  // Exposto na rede, toda chamada leva o token; local, `window.TOKEN` é vazio e nada muda.
  return fetch(r + '?' + new URLSearchParams(window.TOKEN ? { ...p, t: window.TOKEN } : p))
    .then(x => x.json())
    .finally(() => { emVoo.delete(id); marcarCarga(); });
};
// `ignorado` = a checagem não se aplica aqui. `indisponível` = ela deveria ter rodado e não rodou.
const ROTULO = {ok:'ok', aviso:'aviso', atencao:'atenção', manual:'julgar',
  ignorado:'ignorado', indisponivel:'indisponível',
  carregando:'consultando…'};

// Esqueleto na forma do que vem, em vez da palavra "carregando": mostra quanto vem e onde, e a tela
// não pula quando o conteúdo entra no lugar.
// Círculo girando, não barra cinza — mas a CAIXA continua reservada: são estas alturas que
// derrubaram o deslocamento de layout de 0,232 para 0,0375. Um giro solto não ocupa espaço, e sem o
// espaço reservado o salto volta inteiro quando o conteúdo entra.
const girando = altura => `<div class="carregando" style="min-height:${altura}px"><span class="giro"></span></div>`;
const esq = (classe = '') => girando(/l2|titulo/.test(classe) ? 22 : 25);
const esqLinhas = (...larguras) => girando(larguras.length * 25);
const esqRepos = n => girando(Math.max(1, n) * 26);
const esqCodigo = n => girando(Math.max(2, n) * 15 + 26);
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
// Geração do CHAMADO, separada da do repo: o `/api/prs` bate no `gh` e leva segundos, e trocar de
// chamado antes da resposta fazia a lista do anterior cair na trilha do atual — o "bug dos PRs" que
// se resolvia saindo e voltando, porque a segunda ida re-renderizava com a resposta certa.
let geracaoChamado = 0;
let visao = 'chamados';
// De onde a pessoa veio, para o "voltar" das Configurações devolvê-la ao mesmo lugar.
let visaoAnterior = 'chamados';
const SECOES_SANFONA = [['sanfona-chamados', 'chamados'], ['sanfona-implantacao', 'implantacao']];
// `trocarVisao` e o `toggle` da sanfona se chamam um ao outro. A trava faz a ida e a volta
// terminarem na primeira passada, em vez de depender de a recursão convergir sozinha.
// Declarados AQUI, com o resto do estado do módulo: `const` tem zona morta, e lá embaixo eles
// estouravam no `ligarSanfona()` do início — "Cannot access 'SECOES_SANFONA' before initialization",
// que derrubava a montagem da lista de chamados inteira.
let sincronizandoSanfona = false;
let chamados = [];
let estadoAgente = { rodando: null, passos: 0 };
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
// Substitui só o cartão que mudou. Reescrever a lista inteira acontecia 6 vezes numa abertura (uma
// por resposta que chega) — era isso que fazia o centro piscar — e FECHAVA os cartões que a pessoa
// tinha aberto, porque o novo HTML nasce sem o `open`.
function desenharCartoes(itens) {
  const alvo = document.getElementById('cartoes');
  const ordenados = [...itens].sort((a, b) =>
    (ORDEM.indexOf(a.grupo) + 1 || 99) - (ORDEM.indexOf(b.grupo) + 1 || 99));
  const existentes = new Map([...alvo.children].map(el => [el.dataset.id, el]));
  const desenhados = ordenados.map(i => {
    const antigo = existentes.get(i.id);
    const html = cartao(i);
    // Compara sem o `open`: o atributo é escolha da pessoa, não conteúdo, e mantê-lo fora da
    // comparação é o que impede a resposta seguinte de fechar o cartão que ela acabou de abrir.
    if (antigo && semAberto(antigo.outerHTML) === semAberto(html)) {
      return antigo;
    }
    const molde = document.createElement('div');
    molde.innerHTML = html;
    const novo = molde.firstElementChild;
    if (antigo?.open) {
      novo.open = true;
    }
    return novo;
  });
  // Só mexe no DOM se a sequência mudou de fato.
  const igual = desenhados.length === alvo.children.length
    && desenhados.every((el, n) => alvo.children[n] === el);
  if (igual) {
    return;
  }
  suave(() => alvo.replaceChildren(...desenhados));
}

const semAberto = html => html.replace(/\s+open(=""|='')?/, '');

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
    return `<div class="check st-carregando" data-id="${i.id}" aria-busy="true">
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
    return `<div class="check st-${i.status} sem-corpo" data-id="${i.id}"><div class="linha1">${resumo}</div></div>`;
  }
  return `<details class="check st-${i.status}" data-id="${i.id}">
    <summary class="linha1">${resumo}</summary>
    <div class="corpo-check">${corpo}</div>
  </details>`;
}

async function carregarChamados() {
  const r = await api('/api/chamados', {});
  const ocultos = r.ocultos || [];
  chamados = r.lista || [];
  // Recarregar a página no meio de uma corrida não pode perder o estado dela: ele vem do servidor.
  estadoAgente = r.agente || { rodando: null, passos: 0 };
  if (estadoAgente.rodando) {
    marcarBotaoAgenteRodando();
  }
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
       <div class="lista-ocultos">${ocultos.map(o => `
         <button onclick="mostrar('${o.chamado}')" title="Trazer de volta">
           <span class="oc-id">${o.chamado}</span>
           ${o.titulo ? `<span class="oc-sub">${esc(o.titulo)}</span>` : ''}
         </button>`).join('')}</div>`
    : '';
  marcarPinosDaBarra(chamados);
  // `?chamado=UND-1638` (e `&projeto=`) na URL: é o que faz o link ser passável — abrir a tela já
  // no chamado certo, de outra máquina, sem procurar na barra.
  const pedido = new URLSearchParams(location.search);
  const daUrl = (pedido.get('chamado') || '').toUpperCase();
  if (!atual && daUrl && chamados.some(c => c.chamado === daUrl)) {
    abrirChamado(daUrl, pedido.get('projeto') || null);
    return;
  }
  if (!atual && chamados.length) {
    abrirChamado(chamados[0].chamado);
  }
}

// O pino da linha do chamado é o PIOR dos repos dele: a barra tem que dizer onde olhar antes de
// você abrir. Roda em segundo plano, um repo por vez — o servidor é síncrono no que é local.
// Todos os repos de todos os chamados de uma vez. Eram dois laços com `await` dentro: 7 chamados
// vezes N repos, um pedido esperando o outro, e a carga da tela ia de 7,4 s a 12,6 s por causa
// disto. Os pedidos são independentes — o único acoplamento é o pior estado por chamado, que se
// calcula depois de todos voltarem.
async function marcarPinosDaBarra(lista) {
  const pedidos = lista.flatMap(c => c.repos.map(r =>
    api('/api/qualidade', { chamado: c.chamado, projeto: r.projeto, ref: r.ref || '' })
      .then(q => ({ c, r, itens: q.itens || [] }))
      .catch(() => ({ c, r, itens: null }))));
  const porChamado = new Map(lista.map(c => [c.chamado, { pior: 'ok', achados: 0 }]));
  for (const { c, r, itens } of await Promise.all(pedidos)) {
    if (!itens) {
      continue;
    }
    const acc = porChamado.get(c.chamado);
    acc.achados += itens.filter(i => i.status === 'atencao' || i.status === 'aviso').length;
    const p = pinoDo(itens);
    if (p === 'atencao' || (p === 'aviso' && acc.pior !== 'atencao')) {
      acc.pior = p;
    }
    // Guarda para a área de menu não recalcular ao abrir.
    r.pino = p;
  }
  for (const [chamado, { pior, achados }] of porChamado) {
    const pino = document.querySelector(`.linha-chamado[data-c="${chamado}"] .pino-repo`);
    if (pino) {
      pino.className = `pino-repo p-${pior}`;
      pino.title = achados ? `${achados} achado(s) neste chamado` : 'nada a corrigir na conferência local';
    }
  }
}

// O chamado abre em duas partes: um cabeçalho fino no topo do conteúdo, e a TRILHA à direita com as
// branches e o Linear. A trilha é recolhível porque o diff é a coisa mais larga do app.
async function abrirChamado(chamado, projetoPedido = null) {
  const c = chamados.find(x => x.chamado === chamado);
  if (!c) { return; }
  for (const b of document.querySelectorAll('.linha-chamado')) {
    b.classList.toggle('ativo', b.dataset.c === chamado);
  }
  const cab = document.getElementById('cabecalho');
  cab.hidden = false;
  cab.innerHTML = `
    <span class="cab-id">${chamado}</span>
    <span class="cab-titulo" id="cab-titulo">${esq('esq-linha esq-l2')}</span>
    <span class="carga-texto" id="carga-texto"></span>
    <button class="cab-link" onclick="copiarLink()" title="copiar o link desta tela">🔗</button>
    <span id="cab-agente"></span>`;
  marcarCarga();
  redesenharAgenteNoTopo();

  const trilha = document.getElementById('trilha');
  trilha.hidden = false;
  document.getElementById('trilha-corpo').innerHTML = `
    <div class="tr-secao" id="tr-chamado">
      <div class="tr-titulo">Chamado</div>
      <div class="tr-carregando">${esqLinhas('l1', 'l3', 'l4')}</div>
    </div>
    <div class="tr-secao" id="tr-merge"></div>
    <details class="tr-secao tr-dobra" id="tr-dobra-branches" ${aberta('branches')}>
      <summary class="tr-titulo">Branches</summary>
      <div class="tr-chips" id="tr-chips">${c.repos.map(r => `
        <button class="chip ${r.naBranch ? '' : 'fora'}" data-p="${r.projeto}" data-c="${chamado}"
                data-ref="${r.ref || ''}" onclick="abrir(this)"
                title="${r.naBranch
                  ? `checkout em ${r.branchAtual}`
                  : `tem a branch ${chamado}, mas o checkout local está em ${r.branchAtual} — o diff usa a branch do chamado`}">
          <span class="pino-repo p-${r.pino || 'vazio'}"></span>
          <span class="chip-texto">
            <span class="chip-nome">${r.projeto}</span>
            <span class="chip-branch" title="branch comparada${r.pr ? ` — PR #${r.pr}` : ''}">${esc(r.branch || chamado)}${r.pr ? ` · #${r.pr}` : ''}</span>
          </span>
          ${r.situacao ? `<span class="chip-sit s-${r.situacao}" title="decidido pelo agente">${r.situacao === 'resolvido' ? '✓' : '●'}</span>` : ''}
          ${r.sujo ? `<span class="chip-sujo" title="${r.sujo} não commitado(s)">${r.sujo}✎</span>` : ''}
          ${r.naBranch || (r.branch && r.branch === r.branchAtual) ? '' : `<span class="chip-fora" title="o checkout local está em ${esc(r.branchAtual)}, não nesta branch">≠</span>`}
        </button>`).join('')}</div>
    </details>
    <details class="tr-secao tr-dobra" id="tr-prs" style="--altura-prs:${c.repos.length * 26}px" ${aberta('prs')}>
      <summary class="tr-titulo">Pull requests</summary>
      <div class="tr-carregando">${esqRepos(c.repos.length)}</div>
    </details>
    <div class="tr-pe">
      <div class="tr-estado" id="tr-estado">${estadoDaComparacao(c)}</div>
      ${window.LOCAL === false
    ? `<div class="tr-nota-lan">A corrida do agente só roda na máquina do servidor.
         Aqui a tela é para ver — as decisões já gravadas valem igual.</div>`
    : `<button class="tr-agente" id="btn-agente" onclick="pedirAoAgente('${chamado}')"
              title="roda o Claude para decidir a comparação certa de cada repo e recarrega o chamado — leva minutos">
        <span class="tr-cog" aria-hidden="true">🧙</span><span>pedir ao agente</span>
      </button>`}
    </div>`;
  for (const [secao, id] of [['branches', 'tr-dobra-branches'], ['prs', 'tr-prs']]) {
    const el = document.getElementById(id);
    if (el) { lembrarDobra(secao, el); }
  }
  aplicarRecolhido();

  // Identidade e PRs chegam depois: é rede.
  const tokenChamado = ++geracaoChamado;
  api('/api/prs', { chamado, projetos: c.repos.map(x => x.projeto).join(',') }).then(r => {
    if (tokenChamado !== geracaoChamado) { return; }
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
      // Trocar o innerHTML da seção inteira apagava o <summary> e o listener da dobra: o corpo é
      // um elemento próprio, e só ele é redesenhado.
      prAlvo.querySelector('summary').innerHTML = `Pull requests
        <span class="tr-conta">${comPr.length}${abertas ? ` · ${abertas} aberta(s)` : ''}</span>`;
      let corpoPr = prAlvo.querySelector('.tr-corpo');
      if (!corpoPr) {
        corpoPr = document.createElement('div');
        corpoPr.className = 'tr-corpo';
        prAlvo.appendChild(corpoPr);
      }
      prAlvo.querySelector('.tr-carregando')?.remove();
      const htmlPr = `
        ${comPr.map(x => `
          <a class="tr-pr ${x.doLinear ? 'so-linear' : (x.foraDaVarredura ? 'so-busca' : '')} ${classeDecisao(x)}"
             href="${x.url}" target="_blank" rel="noopener"
             title="${esc(x.titulo || '')}\n\n${esc(x.rotulo)}${x.doLinear ? ' · só o Linear conhece este PR'
               : (x.foraDaVarredura ? ' · fora da varredura local: repo não clonado aqui, ou branch com sufixo' : '')}">
            <span class="tr-pr-estado pr-${x.estado.toLowerCase()}" title="${esc(x.rotulo)}"></span>
            <span class="tr-pr-num">${classeDecisao(x) === 'decidida' ? '★ ' : ''}#${x.numero}</span>
            <span class="tr-pr-repo">${esc(x.projeto)}</span>
            <span class="tr-pr-seta">↗</span>
          </a>`).join('') || '<div class="tr-nota">nenhum PR</div>'}
        ${semPr.length ? `<div class="tr-sem-pr">sem PR: ${esc(semPr.join(', '))}</div>` : ''}`;
      // Só troca se mudou: a lista de 28 PRs era reescrita a cada resposta, e cada reescrita é um
      // pisca na trilha.
      if (corpoPr.innerHTML !== htmlPr) {
        suave(() => { corpoPr.innerHTML = htmlPr; });
      }
    }
    pintarAbasDoAtual();
  });

  // Volta para onde você estava neste chamado; sem memória, cai no repo com o pior pino.
  const lembrado = projetoPedido || localStorage.getItem(`repo-${chamado}`);
  const chipLembrado = lembrado && document.querySelector(`.chip[data-p="${lembrado}"][data-c="${chamado}"]`);
  if (chipLembrado) {
    abrir(chipLembrado);
    return;
  }
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
async function abrir(chip, forcar = false) {
  // Reabrir o repo que já está aberto refazia tudo: 2 pedidos de /api/arquivos e cada arquivo aberto
  // pintado em dobro. `recarregar` e `tirarPonto` passam `forcar` porque aí é para refazer mesmo.
  // Por projeto+ref, não por nó: a trilha recria os chips quando os PRs chegam, e comparar
  // identidade de elemento falhava — o mesmo repo era reaberto e pintado de novo.
  if (!forcar && atual?.dados && atual.projeto === chip.dataset.p
      && (atual.ref || '') === (chip.dataset.ref || '')) {
    atual.botao = chip;
    chip.classList.add('ativo');
    return;
  }
  document.querySelectorAll('.chip').forEach(b => b.classList.remove('ativo'));
  chip.classList.add('ativo');
  atual = { projeto: chip.dataset.p, chamado: chip.dataset.c, ref: chip.dataset.ref || '', botao: chip };
  try { localStorage.setItem(`repo-${atual.chamado}`, atual.projeto); } catch { /* sem storage, sem memória */ }
  // A URL acompanha: copiar da barra do navegador e mandar para alguém abre no mesmo lugar.
  const q = new URLSearchParams(location.search);
  q.set('chamado', atual.chamado);
  q.set('projeto', atual.projeto);
  history.replaceState(null, '', `${location.pathname}?${q}`);
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

  api('/api/arquivos', { projeto: atual.projeto, ref: atual.ref, chamado: atual.chamado }).then(d => {
    if (token !== geracao) { return; }
    atual.base = d.base;
    atual.dados = d;
    montarArquivos(d);
    marcarCarimbo(d);
  });
  api('/api/qualidade', { chamado: atual.chamado, projeto: atual.projeto, ref: atual.ref }).then(q => {
    if (token !== geracao) { return; }
    itensDoAtual.locais = q.itens;
    pintarAbasDoAtual(token);
  });
  api('/api/lint', { projeto: atual.projeto, ref: atual.ref, chamado: atual.chamado }).then(r => {
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
    // O `gh` só responde depois, e é ele que sabe o estado da PR: sem redesenhar, a faixa ficava
    // dizendo "não decidido" com o cartão de mesclagem ao lado já dizendo que a PR entrou.
    atual.pr = r.prBase ? { numero: r.prBase.number, estado: r.prBase.state } : null;
    if (atual.dados) {
      desenharFaixaMerge(atual.dados);
    }
    pintarAbasDoAtual(token);
  });
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
  tirarOverlay();
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

function marcarCarimbo(d, fonteForcada) {
  const c = document.getElementById('carimbo');
  if (!c) { return; }
  const quando = d.desde ? new Date(d.desde).toLocaleTimeString('pt-BR') : '';
  // Comparação não definida é palpite, e palpite não anunciado foi o que fez a tela mostrar 0
  // arquivo em 8 repos onde as PRs mostravam de 1 a 65. Aqui ele é anunciado.
  // Base informada é a comparação de release: não há decisão nem mesclagem a declarar aqui, e
  // dizer "null (branch) · aberto" era ruído sobre um diff que não é de chamado nenhum.
  const fonte = fonteForcada
    || (d.via === 'informada'
    ? `${esc(atual?.ref || '')} contra a base de ${esc(atual?.projeto || '')}`
    : d.via !== 'local'
      ? `${d.baseNome}${d.decisao?.pr ? '' : ' (branch)'}`
      : `base ${d.baseNome || (d.base || '').slice(0, 8)} · ⚠ ${d.erroDaDecisao
        ? `decisão ignorada: ${d.erroDaDecisao}` : 'comparação não definida'}`);
  // `??` não entra em diff nenhum: sem esta frase, "12 ✎" no chip ao lado de um diff de 5 parecia
  // bug do diff — era o diff sendo fiel ao git. O passo 1.0 da rotina de fim é quem resolve.
  const novos = (d.naoRastreados || []).length;
  // `revalidando` = o que está na tela é do cache e já expirou; o novo vem por SSE quando muda.
  c.textContent = `${d.arquivos.length} arquivo(s) · ${fonte}`
    + (d.revalidando ? ' · atualizando…' : '')
    + (novos ? ` · ⚠ ${novos} novo(s) fora do diff — nunca passaram pelo git add` : '')
    + (d.via !== 'local' && d.via !== 'informada' ? ` · ${d.mesclado ? 'resolvido' : 'aberto'}` : '')
    + (d.via === 'local' && d.mesclado ? (d.comoSoube === 'conteudo' ? ' · mesclado (squash)' : ' · mesclado') : '')
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

// A altura do corpo é RESERVADA a partir do tamanho da mudança, que o /api/arquivos já informa.
// Com esqueleto fixo de 6 linhas contra conteúdo de centenas, cada arquivo pintado empurrava tudo
// abaixo dele — medido: dois saltos de ~0,095 de CLS por abertura, os maiores da tela. A conta é a
// da dobra: linhas mudadas mais o contexto dos dois lados, com teto.
const linhasEstimadas = a => Math.min(140, (a.adicionadas || 0) + (a.removidas || 0) + 14);

function linhaDeArquivo(a, aberto) {
  const linhas = linhasEstimadas(a);
  return `<details class="arq" data-caminho="${esc(a.caminho)}" data-linhas="${linhas}" ${aberto ? 'open' : ''}>
    <summary><b>${esc(a.nome || a.caminho)}</b><span class="badge">${a.estado}</span>
      <span class="mais">+${a.adicionadas}</span><span class="menos">-${a.removidas}</span>
      <span class="dobra"></span></summary>
    <div class="corpo" style="min-height:${linhas * 15 + 26}px"></div>
  </details>`;
}

// Pasta de teste vai para o FIM e nasce recolhida: o teste é o que menos se lê na conferência, e
// ocupando o topo empurrava o código para baixo da dobra. `spec`/`test`/`tests`/`__tests__`.
const EH_TESTE = nome => /^(spec|specs|test|tests|__tests__|testes)$/i.test(nome);
const ehArquivoDeTeste = n => /(\.|-)(spec|test)\.[a-z]+$|^test_|_test\.[a-z]+$/i.test(n);

function renderNo(no, aberto, nivel) {
  const pastas = [...no.pastas.entries()]
    .sort(([a], [b]) => (EH_TESTE(a) - EH_TESTE(b)) || a.localeCompare(b))
    .map(([nome, filho]) => {
      const [rotulo, alvo] = comprimir(nome, filho);
      const qtd = totalDeArquivos(alvo);
      const teste = EH_TESTE(nome);
      return `<details class="pasta ${teste ? 'de-teste' : ''}" ${aberto && !teste ? 'open' : ''} style="--nivel:${nivel}">
      <summary><span class="cam">${esc(rotulo)}</span>
        <span class="qtd-arq">${qtd}</span>
        ${teste ? '<span class="selo-teste">teste</span>' : ''}
        <span class="mais">+${alvo.adicionadas}</span><span class="menos">-${alvo.removidas}</span></summary>
      <div class="dentro">${renderNo(alvo, aberto && !teste, nivel + 1)}</div>
    </details>`;
    }).join('');
  const arquivos = no.arquivos
    .sort((a, b) => (ehArquivoDeTeste(a.nome) - ehArquivoDeTeste(b.nome)) || a.nome.localeCompare(b.nome))
    .map(a => linhaDeArquivo(a, aberto && !ehArquivoDeTeste(a.nome) && abrirTudoGlobal))
    .join('');
  return pastas + arquivos;
}

let totalDeArquivosGlobal = 0;
// Todo arquivo que não é teste nasce aberto — era `<= 4`, e num diff de 11 nada abria. O teto existe
// porque abrir é uma requisição por arquivo: num diff de 65 seriam 65 de uma vez.
const TETO_ABRIR_TUDO = 30;
let abrirTudoGlobal = true;

// A mesclagem vinha só como uma palavra no meio do carimbo, e o resto do chamado não aparecia em
// lugar nenhum. Aqui o estado deste repo é um selo, e os outros repos são uma trilha de células —
// dá para ver de longe o que já entrou e o que falta, sem abrir um por um.
function desenharFaixaMerge(d) {
  const alvo = document.getElementById('tr-merge');
  if (!alvo) { return; }
  const c = chamados.find(x => x.chamado === atual?.chamado);
  const repos = c?.repos || [];
  const estado = d.via === 'local' ? 'indefinido' : (d.mesclado ? 'mesclado' : 'aberto');
  const selo = { mesclado: 'mesclado', aberto: 'aberto', indefinido: 'não decidido' }[estado];
  // Sem decisão, o que o `gh` sabe entra como pista — declarada como pista, não como decisão.
  const pista = estado === 'indefinido' && atual?.pr
    ? `gh: PR #${atual.pr.numero} ${atual.pr.estado === 'MERGED' ? 'mesclada' : atual.pr.estado.toLowerCase()}`
    : '';
  const feitos = repos.filter(r => r.situacao === 'resolvido').length;
  const semDecisao = repos.filter(r => !r.situacao).length;
  const celulas = repos.map(r => {
    const st = r.situacao === 'resolvido' ? 'ok' : r.situacao === 'aberto' ? 'aberto' : 'nada';
    const nota = r.situacao
      ? `${r.pr ? `PR #${r.pr} · ` : ''}${r.situacao}`
      : 'sem decisão — a tela usa o palpite local';
    return `<button class="fm-cel c-${st} ${r.projeto === atual.projeto ? 'aqui' : ''}"
      title="${esc(r.projeto)} — ${esc(nota)}" onclick="irParaRepo('${r.projeto}')"></button>`;
  }).join('');
  alvo.innerHTML = `<div class="tr-titulo">Mesclagem</div>
    <div class="fm-topo">
      <span class="fm-selo s-${estado}">${selo}</span>
      <span class="fm-onde">${esc(d.baseNome || (d.base || '').slice(0, 8))}</span>
    </div>
    ${pista ? `<div class="fm-pista">${esc(pista)} — ninguém decidiu ainda</div>` : ''}
    <div class="fm-trilha">${celulas}</div>
    <div class="fm-conta">${feitos} de ${repos.length} mesclados${
      semDecisao ? ` · <b>${semDecisao} sem decisão</b>` : ''}</div>`;
}

// Fecha o laço decisão ↔ lista: a PR que o agente escolheu leva ★, e as outras do MESMO repo ficam
// esmaecidas — são as que já entraram antes, ou as que perderam. Sem isso eram 28 PRs iguais.
function classeDecisao(pr) {
  const c = chamados.find(x => x.chamado === atual?.chamado);
  const repo = c?.repos.find(r => r.projeto === pr.projeto);
  if (!repo?.pr) { return ''; }
  return Number(repo.pr) === Number(pr.numero) ? 'decidida' : 'preterida';
}

function irParaRepo(projeto) {
  const chip = document.querySelector(`.chip[data-p="${projeto}"][data-c="${atual?.chamado}"]`);
  if (chip) { abrir(chip); }
}

// Sai na primeira coisa de verdade que chega, com fade, e não volta: da segunda carga em diante o
// que avisa é o fio no topo.
function tirarOverlay() {
  const o = document.getElementById('carregando-tela');
  if (!o) { return; }
  o.classList.add('saindo');
  setTimeout(() => o.remove(), 240);
  // A barra de rolagem entra 1 s depois do conteúdo, com fade: o espaço dela já está reservado, e
  // aparecer de estalo no meio do resto que ainda está chegando é justamente o que incomoda.
  setTimeout(() => document.body.classList.add('com-barra'), 1000);
}

function montarArquivos(d) {
  tirarOverlay();
  const caixa = document.getElementById('arquivos');
  if (!caixa) { return; }
  caixa.className = '';
  desenharFaixaMerge(d);
  totalDeArquivosGlobal = d.arquivos.length;
  const naoTeste = d.arquivos.filter(a => !ehArquivoDeTeste(a.caminho.split('/').pop())).length;
  abrirTudoGlobal = naoTeste <= TETO_ABRIR_TUDO;
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
  const aviso = abrirTudoGlobal ? ''
    : `<p class="aviso-teto">${naoTeste} arquivos de código: acima de ${TETO_ABRIR_TUDO} eles nascem
       fechados, porque abrir é uma requisição por arquivo. Clique no que interessa.</p>`;
  caixa.innerHTML = aviso + renderNo(arvoreDe(d.arquivos), true, 0);
  for (const det of caixa.querySelectorAll('details.arq')) {
    det.addEventListener('toggle', () => { if (det.open) { pintar(det); } });
    if (det.open) { pintar(det); }
  }
}

async function tirarPonto(evento, id) {
  evento.preventDefault();
  evento.stopPropagation();
  await api('/api/ponto-remover', { id });
  abrir(atual.botao, true);
}


async function recarregar() {
  if (!atual) { return; }
  await api('/api/invalidar', { projeto: atual.projeto, silencioso: 1 });
  abrir(atual.botao, true);
}

// O servidor avisa quando o cache de um projeto cai (o hook de commit dispara isso).
function escutarEventos() {
  const fonte = new EventSource('/api/eventos' + (window.TOKEN ? `?t=${encodeURIComponent(window.TOKEN)}` : ''));
  fonte.onmessage = e => {
    let dados = {};
    try { dados = JSON.parse(e.data); } catch { return; }
    // Reinício do servidor com app.js novo: a aba antiga estava mostrando comportamento velho sem
    // nenhum sinal — o cliente sem o parâmetro `chamado` caía no diff local e ninguém sabia por quê.
    if (dados.versao && window.VERSAO && dados.versao !== window.VERSAO) {
      avisarNaTela('versão nova da tela — recarregando');
      return setTimeout(() => location.reload(), 400);
    }
    if (dados.tipo === 'agente') {
      const p = document.getElementById('pa-passo');
      if (p && dados.passo) { p.textContent = `passo ${dados.passo}`; }
      estadoAgente = dados.fase === 'fim'
        ? { rodando: null, passos: 0 }
        : { rodando: dados.chamado, passos: dados.passo || 0 };
      redesenharEstado();
      redesenharAgenteNoTopo(dados.fase === 'fim' ? dados : null);
      if (corridaAberta && dados.fase === 'andando') {
        corridaAberta.eventos = (corridaAberta.eventos || [])
          .concat({ passo: dados.passo, em: new Date().toISOString(), ferramenta: dados.ferramenta, texto: dados.texto });
      }
      atualizarModalEstado();
      painelAgente(dados.texto || '', dados.fase === 'fim' ? (dados.ok ? 'fim' : 'erro') : '', dados.ferramenta || '');
      if (dados.fase === 'fim' && dados.chamado === 'implantação') {
        estadoAgente = { rodando: null, passos: 0 };
        redesenharAgenteNoTopo(dados);
        // Quem mandou analisar ficou esperando: a modal abre sozinha no fim. O botão da trilha
        // fica para reabrir depois — e é ele que sobrevive ao reload.
        marcarAnaliseDisponivel().then(() => {
          if (document.getElementById('btn-analise')) { abrirModalAnalise(); }
        });
        return;
      }
      if (dados.fase === 'fim') {
        pararBotaoAgente();
        painelAgente(dados.ok ? `terminou em ${dados.segundos}s — recarregando a tela` : 'terminou com erro',
          dados.ok ? 'fim' : 'erro');
        if (dados.ok) {
          const c = atual?.chamado || dados.chamado;
          carregarChamados().then(() => abrirChamado(c));
        }
      }
      return;
    }
    // Revalidação terminada e o valor MUDOU: a tela já mostrou o velho e agora troca. Vem só
    // quando muda de verdade — o servidor compara a impressão antes de avisar, senão seria piscada.
    if (dados.tipo === 'atualizado') {
      agendarRedesenho(dados.chave);
      return;
    }
    if (dados.tipo !== 'invalidado' || !atual) { return; }
    if (dados.projeto && dados.projeto !== atual.projeto) { return; }
    avisarNaTela(dados.projeto ? `${dados.projeto} mudou — recarregando` : 'cache limpo — recarregando');
    const chamado = atual.chamado;
    carregarChamados().then(() => abrirChamado(chamado));
  };
}

// Três estados, e a diferença entre eles é o que a pessoa precisa saber antes de clicar: o agente
// ainda está de pé? já calculou? calculou TUDO? Antes só se descobria vendo a tela mudar (ou não).
// Recolher e a tela esquecer no próximo clique não serve para nada: o estado fica no localStorage.
const aberta = secao => (localStorage.getItem(`dobra-${secao}`) === 'fechada' ? '' : 'open');

function lembrarDobra(secao, el) {
  el.addEventListener('toggle', () => {
    localStorage.setItem(`dobra-${secao}`, el.open ? 'aberta' : 'fechada');
  });
}

// A linha de estado é um botão: abre a modal com o que está acontecendo, repo a repo — qual PR,
// que situação, por que, quando — e o log do agente se ele estiver (ou tiver acabado de) rodar.
function estadoDaComparacao(c) {
  const abre = `onclick="abrirModalEstado('${c.chamado}')" title="ver o que está acontecendo, repo a repo"`;
  if (estadoAgente.rodando === c.chamado) {
    return `<button class="est rodando" ${abre}><span class="giro"></span>agente rodando${
      estadoAgente.passos ? ` · passo ${estadoAgente.passos}` : ''} <span class="est-seta">›</span></button>`;
  }
  const total = c.repos.length;
  if (!c.decididos) {
    return `<button class="est nada" ${abre}>✗ não calculado — a tela está no palpite local <span class="est-seta">›</span></button>`;
  }
  if (c.decididos < total) {
    return `<button class="est parcial" ${abre}>◐ calculado em ${c.decididos} de ${total} repos${quando(c.calculadoEm)} <span class="est-seta">›</span></button>`;
  }
  return `<button class="est pronto" ${abre}>✓ pronto — ${total} de ${total} repos${quando(c.calculadoEm)} <span class="est-seta">›</span></button>`;
}

let corridaAberta = null;

async function abrirModalEstado(chamado) {
  document.getElementById('modal-estado')?.remove();
  const c = chamados.find(x => x.chamado === chamado);
  if (!c) { return; }
  corridaAberta = null;
  const m = document.createElement('dialog');
  m.id = 'modal-estado';
  m.innerHTML = renderModalEstado(c);
  m.addEventListener('click', e => { if (e.target === m) { m.close(); } });
  m.addEventListener('close', () => m.remove());
  document.body.appendChild(m);
  m.showModal();
  // A execução vem do servidor, não do painel desta aba: sobrevive ao reload e ao reinício.
  corridaAberta = await api('/api/agente-log', { chamado });
  atualizarModalEstado();
}

function renderModalEstado(c) {
  const linhas = [...c.repos].sort((a, b) => {
    const peso = { aberto: 0, undefined: 1, null: 1, resolvido: 2 };
    return (peso[a.situacao] ?? 1) - (peso[b.situacao] ?? 1) || a.projeto.localeCompare(b.projeto);
  }).map(r => {
    const d = r.decisao;
    const st = r.situacao === 'resolvido' ? 'ok' : r.situacao === 'aberto' ? 'aberto' : 'nada';
    const marca = { ok: '✓', aberto: '●', nada: '✗' }[st];
    const onde = !d ? '<i>sem decisão — a tela usa o palpite local</i>'
      : d.via === 'pr' ? `PR <b>#${d.pr}</b> → ${esc(d.destino || 'base')}`
        : `${esc(d.branch || '')} × ${esc(d.base || 'origin/stage')}`;
    return `<tr class="me-${st}" onclick="irParaRepo('${r.projeto}');document.getElementById('modal-estado').close()">
      <td class="me-marca">${marca}</td>
      <td class="me-repo">${esc(r.projeto)}<div class="me-branch">${esc(r.branch || c.chamado)}</div></td>
      <td class="me-onde">${onde}${d?.nota ? `<div class="me-nota">${esc(d.nota)}</div>` : ''}</td>
      <td class="me-quando">${d?.em ? quando(d.em).replace(/^ · /, '') : ''}</td>
    </tr>`;
  }).join('');
  const rodando = estadoAgente.rodando === c.chamado;
  const cor = corridaAberta;
  const eventos = cor?.eventos || [];
  const log = eventos.length ? eventos.map(e => `<div class="me-ev">
      <span class="me-ev-passo">${e.passo}</span>
      ${e.ferramenta ? `<code class="me-ev-ferr">${esc(e.ferramenta)}</code>` : ''}
      <span class="me-ev-hora">${e.em ? new Date(e.em).toLocaleTimeString('pt-BR') : ''}</span>
      <pre class="me-ev-texto">${esc(e.texto || '')}</pre>
    </div>`).join('') : '';
  const cabecaLog = cor ? `${rodando ? 'o agente agora' : 'última corrida'} · ${eventos.length} passo(s)${
    cor.segundos ? ` em ${cor.segundos}s` : ''}${cor.modelo ? ` · ${esc(cor.modelo)} esforço ${esc(cor.esforco || '?')}` : ''}${
    cor.inicio ? ` · ${new Date(cor.inicio).toLocaleString('pt-BR')}` : ''}` : '';
  const conferencia = cor?.divergentes
    ? (cor.divergentes.length
      ? `<div class="me-diverg">⚠ ${cor.divergentes.length} não bateu: ${esc(cor.divergentes.join(' · '))}</div>`
      : '<div class="me-confere">✓ todos os números batem com as PRs</div>')
    : '';
  return `<div class="me-cabeca">
      <div><div class="me-titulo">${c.chamado} — comparação por repo</div>
        <div class="me-sub">${c.decididos} de ${c.repos.length} decididos${quando(c.calculadoEm)}${
          rodando ? ` · <span class="est rodando"><span class="giro"></span>agente rodando · passo ${estadoAgente.passos}</span>` : ''}</div></div>
      <button class="pa-fechar" onclick="document.getElementById('modal-estado').close()" title="fechar (Esc)">×</button>
    </div>
    <table class="me-tabela"><tbody>${linhas}</tbody></table>
    ${conferencia}
    ${log ? `<div class="me-log-titulo">${cabecaLog}
               <button class="me-copiar" onclick="copiarCorrida()">copiar</button></div>
             <div class="me-log">${log}</div>`
    : '<div class="me-log-titulo">nenhuma corrida registrada para este chamado</div>'}
    <div class="me-pe">Clicar numa linha abre o repo. As decisões ficam na tabela <code>decisoes</code>
      do <code>qualidade/qualidade.db</code>: <code>comparacao.mjs definir/remover</code> muda uma,
      <code>comparacao.mjs listar</code> mostra as gravadas. Editar o <code>comparacoes.json</code>
      à mão não muda mais nada — ele só foi lido na primeira importação.</div>`;
}

// A modal acompanha a corrida ao vivo: se estiver aberta, cada evento do agente a redesenha.
async function copiarLink() {
  await navigator.clipboard.writeText(location.href);
  avisarNaTela('link copiado — abre no mesmo chamado e repo');
}

async function copiarCorrida() {
  const texto = (corridaAberta?.eventos || [])
    .map(e => `${e.passo}\t${e.ferramenta || 'texto'}\t${e.texto}`).join('\n');
  await navigator.clipboard.writeText(texto);
  avisarNaTela('execução copiada');
}

function atualizarModalEstado() {
  const m = document.getElementById('modal-estado');
  if (!m?.open) { return; }
  const c = chamados.find(x => x.chamado === atual?.chamado);
  if (c) { m.innerHTML = renderModalEstado(c); }
}

function quando(iso) {
  if (!iso) { return ''; }
  const d = new Date(iso);
  const hoje = new Date().toDateString() === d.toDateString();
  return ` · ${hoje ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('pt-BR')}`;
}

// A trilha pode estar recolhida e o olho está no centro: o estado da corrida também vive no topo.
function redesenharAgenteNoTopo(fim = null) {
  const alvo = document.getElementById('cab-agente');
  if (!alvo) { return; }
  if (estadoAgente.rodando) {
    alvo.className = 'cab-agente';
    alvo.innerHTML = `<span class="giro" aria-hidden="true"></span>agente decidindo${
      estadoAgente.passos ? ` · passo ${estadoAgente.passos}` : ''}`;
    return;
  }
  if (fim) {
    alvo.className = `cab-agente ${fim.ok ? 'fim' : 'erro'}`;
    alvo.textContent = fim.ok ? `✓ agente terminou em ${fim.segundos}s` : '✗ agente falhou';
    setTimeout(() => { if (!estadoAgente.rodando) { alvo.innerHTML = ''; alvo.className = ''; } }, 20000);
    return;
  }
  alvo.innerHTML = '';
  alvo.className = '';
}

function redesenharEstado() {
  const alvo = document.getElementById('tr-estado');
  const c = chamados.find(x => x.chamado === atual?.chamado);
  if (alvo && c) {
    alvo.innerHTML = estadoDaComparacao(c);
  }
}

// O clique tem que produzir sinal IMEDIATO: a corrida do agente leva minutos, e botão que não
// responde na hora faz a pessoa clicar de novo (e o servidor recusa a segunda, o que parece quebrado).
async function pedirAoAgente(chamado) {
  const b = document.getElementById('btn-agente');
  if (b?.classList.contains('rodando')) { return; }
  if (b) {
    b.classList.add('rodando');
    b.innerHTML = '<span class="giro" aria-hidden="true"></span><span>agente decidindo…</span>';
  }
  estadoAgente = { rodando: chamado, passos: 0 };
  redesenharEstado();
  redesenharAgenteNoTopo();
  painelAgente(`pedindo ao agente para decidir a comparação de ${chamado}…`, 'inicio');
  const r = await api('/api/agente', { chamado });
  if (!r.ok) {
    painelAgente(r.erro || 'não consegui iniciar', 'erro');
    pararBotaoAgente();
  }
}

// O recarregar saiu do botão: a corrida do agente já derruba o cache do chamado ao terminar, e
// dois botões que terminam no mesmo lugar eram redundantes. Quem quiser só o cache tem o hook de
// commit e a rota /api/invalidar.

function marcarBotaoAgenteRodando() {
  const b = document.getElementById('btn-agente');
  if (b && !b.classList.contains('rodando')) {
    b.classList.add('rodando');
    b.innerHTML = '<span class="giro" aria-hidden="true"></span><span>agente decidindo…</span>';
  }
}

function pararBotaoAgente() {
  const b = document.getElementById('btn-agente');
  if (b) {
    b.classList.remove('rodando');
    b.innerHTML = '<span class="tr-cog" aria-hidden="true">🧙</span><span>pedir ao agente</span>';
  }
}

// Console de progresso. Sem ele o único retorno seria a tela mudando lá na frente, sem explicação.
function painelAgente(texto, classe = '', extra = '') {
  let p = document.getElementById('painel-agente');
  if (!p) {
    p = document.createElement('div');
    p.id = 'painel-agente';
    p.innerHTML = `<header><span class="pa-titulo">agente</span>
      <span class="pa-passo" id="pa-passo"></span>
      <button class="pa-fechar" onclick="this.closest('#painel-agente').remove()">×</button></header>
      <div class="pa-linhas" id="pa-linhas"></div>`;
    document.body.appendChild(p);
  }
  const linhas = p.querySelector('#pa-linhas');
  const linha = document.createElement('div');
  linha.className = `pa-linha ${classe}`;
  linha.innerHTML = extra ? `<code>${esc(extra)}</code> ${esc(texto)}` : esc(texto);
  linhas.appendChild(linha);
  while (linhas.children.length > 120) { linhas.firstChild.remove(); }
  linhas.scrollTop = linhas.scrollHeight;
  return p;
}

// Crossfade nativo quando o navegador tem (Chrome/Safari recentes); sem ele, troca direta como
// antes. Não é biblioteca: é o `startViewTransition` do próprio navegador.
let transicaoEmCurso = false;

function suave(troca) {
  // Uma de cada vez: chamar com outra em curso aborta a anterior e o navegador loga
  // "Transition was skipped" no console — erro visível para quem abre o inspetor.
  if (typeof document.startViewTransition !== 'function' || transicaoEmCurso) {
    troca();
    return;
  }
  transicaoEmCurso = true;
  const t = document.startViewTransition(troca);
  t.finished.catch(() => {}).finally(() => { transicaoEmCurso = false; });
}

// Junta as chaves que chegam quase juntas (diff, checagens e lint revalidam de uma vez) num
// redesenho só, e guarda a rolagem: perder o lugar no diff é pior que ver o dado velho por 1 s.
let redesenhoAgendado = null;
const chavesPendentes = new Set();

function agendarRedesenho(chave) {
  // Na implantação não há chamado nem chip: o redesenho por chamado tentaria reabrir um `botao`
  // que é null. A fila se atualiza ao entrar na visão.
  if (!atual || !chave || atual.implantacao) { return; }
  chavesPendentes.add(chave);
  clearTimeout(redesenhoAgendado);
  redesenhoAgendado = setTimeout(async () => {
    const chaves = [...chavesPendentes];
    chavesPendentes.clear();
    const daBarra = chaves.some(k => k.startsWith('chamados'));
    const doRepo = chaves.some(k => /^(arquivos|arquivo|local|lint)\|/.test(k) && k.includes(atual.projeto));
    const doChamado = chaves.some(k => /^(prs|remoto)\|/.test(k) && k.includes(atual.chamado));
    if (daBarra) {
      await carregarChamados();
    }
    if (doChamado) {
      const alvo = document.querySelector('main');
      const onde = alvo?.scrollTop || 0;
      await abrirChamado(atual.chamado, atual.projeto);
      if (alvo) { alvo.scrollTop = onde; }
    } else if (doRepo) {
      const alvo = document.querySelector('main');
      const onde = alvo?.scrollTop || 0;
      await abrir(atual.botao, true);
      if (alvo) { alvo.scrollTop = onde; }
    }
    if (daBarra || doChamado || doRepo) {
      avisarNaTela('atualizado');
    }
  }, 400);
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
  // Marca ANTES do await: a marca só existia depois, então duas chamadas concorrentes passavam as
  // duas e o mesmo arquivo era buscado em dobro. Com 7 arquivos abrindo juntos, isso multiplica.
  corpo.dataset.pronto = completo ? 'completo' : 'carregando';
  // O esqueleto ocupa a altura estimada em vez de 6 linhas fixas: é o que evita o salto na troca.
  corpo.innerHTML = esqCodigo(Math.min(30, Math.round(Number(det.dataset.linhas || 6) / 3)));
  const r = await api('/api/arquivo', {
    chamado: atual.chamado,
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
  // Herda a altura reservada: sem isto o salto volta exatamente no instante da troca.
  novo.style.minHeight = corpo.style.minHeight;
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
ligarSanfona();
carregarChamados();
escutarEventos();
// A contagem no botão vem já na abertura: saber que há 5 repos esperando não pode exigir clicar.
api('/api/implantacao', {}).then(r => {
  filaImplantacao = r.fila || [];
  escolhidosImplantacao = new Set(r.escolhidos || []);
  marcarContaImplantacao();
});

// ---------- implantação: o que vai de stage para main ----------

const urlDoLinear = id => (window.LINEAR ? `https://linear.app/${window.LINEAR}/issue/${id}` : '#');

let filaImplantacao = [];
let escolhidosImplantacao = new Set();
// O release aberto no centro, e qual commit dele está sendo olhado sozinho (`null` = o release
// inteiro). `geracaoDiffImpl` descarta resposta de clique velho: clicar em três commits seguidos
// dispara três buscas e a que chega por último é que pinta, não a que foi pedida por último.
let buscadoEmImplantacao = null;
let implAtual = null;
let commitAberto = null;
let geracaoDiffImpl = 0;

async function carregarImplantacao() {
  const alvo = document.getElementById('painel-implantacao');
  alvo.innerHTML = girando(120);
  const r = await api('/api/implantacao', {});
  filaImplantacao = r.fila || [];
  escolhidosImplantacao = new Set(r.escolhidos || []);
  buscadoEmImplantacao = r.buscadoEm || null;
  desenharFilaImplantacao();
  marcarContaImplantacao();
  // Só os escolhidos ganham detalhe: são 22 repos à frente, um deles com 563 commits, e calcular
  // tudo é trabalho jogado fora — o resumo é uma contagem, o detalhe é log mais numstat.
  for (const p of escolhidosImplantacao) {
    detalharRepo(p);
  }
}

// A fila inteira sai de `origin/main` e `origin/stage`, que são cópias locais. Enquanto ninguém
// buscar, ela é fiel ao `.git` e mentirosa sobre o GitHub — e as duas coisas têm exatamente a mesma
// aparência. Este carimbo é a única diferença visível entre elas.
function carimboDaBusca() {
  if (!buscadoEmImplantacao) {
    return 'refs nunca buscados nesta sessão';
  }
  const d = new Date(buscadoEmImplantacao);
  const minutos = Math.round((Date.now() - d.getTime()) / 60000);
  if (minutos < 1) {
    return 'refs buscados agora';
  }
  return `refs de ${minutos < 60 ? `${minutos} min atrás` : d.toLocaleString('pt-BR')}`;
}

// `git fetch` nos 51 repos, em paralelo — 2,4 s medidos. Busca TODOS e não só os escolhidos porque
// repo com 0 commits à frente não aparece na fila, e é justamente ele que vira candidato novo ao
// receber o primeiro: um botão que o escondesse repetiria o problema que ele existe para resolver.
async function atualizarImplantacao(evento) {
  // O controle mora dentro do <summary>: sem isto, clicar nele abre e fecha a sanfona junto.
  evento?.stopPropagation();
  evento?.preventDefault();
  const b = document.getElementById('btn-atualizar-impl');
  if (!b || b.classList.contains('girando')) {
    return;
  }
  b.classList.add('girando');
  const r = await api('/api/implantacao-atualizar', {});
  b.classList.remove('girando');
  if (!r.ok) {
    return avisarNaTela(r.erro || 'não consegui buscar');
  }
  filaImplantacao = r.fila || [];
  escolhidosImplantacao = new Set(r.escolhidos || []);
  buscadoEmImplantacao = r.buscadoEm || null;
  desenharFilaImplantacao();
  marcarContaImplantacao();
  // O detalhe de cada escolhido também saiu de refs velhos; o cache do servidor já caiu, então
  // isto relê. Se um deles está aberto no centro, o diff dele é refeito junto.
  for (const projeto of escolhidosImplantacao) {
    detalharRepo(projeto);
  }
  if (atual?.implantacao && atual.projeto) {
    abrirImplantacao(atual.projeto);
  }
  avisarNaTela(`${r.repos} repos buscados em ${r.segundos}s`
    + (r.semRefs?.length ? ` · ${r.semRefs.length} sem main/stage no remoto` : ''));
}

function marcarContaImplantacao() {
  const c = document.getElementById('conta-impl');
  if (c) {
    c.textContent = escolhidosImplantacao.size
      ? `${escolhidosImplantacao.size}/${filaImplantacao.length}` : filaImplantacao.length || '';
  }
  const cc = document.getElementById('conta-chamados');
  if (cc) {
    cc.textContent = chamados.length || '';
  }
}

function desenharFilaImplantacao() {
  const alvo = document.getElementById('painel-implantacao');
  const escolhidos = filaImplantacao.filter(f => escolhidosImplantacao.has(f.projeto));
  const resto = filaImplantacao.filter(f => !escolhidosImplantacao.has(f.projeto));
  const prontos = escolhidos.filter(f => f.implantado).length;
  alvo.innerHTML = `
    <div class="impl-topo">
      <span>${escolhidos.length} de ${filaImplantacao.length} repos${
        prontos ? ` · ${prontos} já na main` : ''}</span>
      <span class="impl-buscado ${buscadoEmImplantacao ? '' : 'nunca'}">${carimboDaBusca()}</span>
    </div>
    ${escolhidos.map(linhaImplantacao).join('') || '<p class="vazio">escolha os repos desta implantação abaixo</p>'}
    ${resto.length ? `<details class="impl-resto" ${escolhidos.length ? '' : 'open'}>
        <summary>${resto.length} repo(s) fora desta implantação</summary>
        ${resto.map(linhaImplantacao).join('')}
      </details>` : ''}`;
}

function linhaImplantacao(f) {
  const marcado = escolhidosImplantacao.has(f.projeto);
  const d = f.detalhe;
  // Implantado é ESTADO, não ausência: a linha fica, com ✓ e o motivo. É a mesma regra que já
  // vale para a branch mesclada na tela de chamado — o fim do trabalho tem que aparecer como fim,
  // não como lista vazia.
  const sub = f.implantado
    ? `✓ já está na main${f.atras ? ` · main ${f.atras} à frente` : ''} — nada a enviar`
    : `${f.commits} commit(s)${f.atras ? ` · main ${f.atras} à frente` : ''}${
      d ? ` · ${d.arquivos} arq · ${d.ids.length} chamado(s)` : ''}`;
  return `<div class="impl-linha ${marcado ? 'escolhido' : ''} ${f.implantado ? 'implantado' : ''}"
        data-p="${f.projeto}">
      <label class="impl-marca" title="entra nesta implantação">
        <input type="checkbox" ${marcado ? 'checked' : ''} onchange="alternarRepo('${f.projeto}')">
      </label>
      <button class="impl-corpo" onclick="abrirImplantacao('${f.projeto}')">
        <span class="impl-nome">${esc(f.projeto)}</span>
        <span class="impl-sub">${sub}</span>
        ${d?.migrates.length ? `<span class="impl-selo" title="${d.migrates.length} migrate(s) neste release">migrate</span>` : ''}
      </button>
    </div>`;
}

// Não redesenhar DENTRO do handler: `desenharFilaImplantacao` troca o innerHTML da lista, o que
// destrói o próprio checkbox que está despachando o `change`. Trocar o nó que emite um evento no
// meio do despacho é receita de evento espúrio, e uma rodada de teste aqui viu os 5 repos
// escolhidos saírem um a um, sozinhos, em menos de um segundo. Grava primeiro, redesenha depois.
async function alternarRepo(projeto) {
  const entrou = !escolhidosImplantacao.has(projeto);
  if (entrou) {
    escolhidosImplantacao.add(projeto);
  } else {
    escolhidosImplantacao.delete(projeto);
  }
  marcarContaImplantacao();
  // Manda QUAL repo mudou, não o conjunto: assim um evento repetido é inócuo. Ver o comentário da
  // rota — o conjunto inteiro transformava repetição de clique em remoção em cascata.
  const r = await api('/api/implantacao-escolher', entrou ? { entra: projeto } : { sai: projeto });
  // A resposta é a verdade do disco, e não o que a tela achava: se dois toggles se cruzaram, é ela
  // que desempata.
  escolhidosImplantacao = new Set(r.escolhidos || []);
  marcarContaImplantacao();
  desenharFilaImplantacao();
  if (entrou) {
    detalharRepo(projeto);
  }
}

async function detalharRepo(projeto) {
  const d = await api('/api/implantacao-detalhe', { projeto });
  const f = filaImplantacao.find(x => x.projeto === projeto);
  if (f && !d.erro) {
    f.detalhe = d;
    desenharFilaImplantacao();
  }
}

// Reusa o visualizador de diff inteiro: ele já aceita base e alvo arbitrários, então o release é
// só outra comparação — merge-base(main, stage) contra stage.
// O resumo do release vai para a trilha, como o metadado do chamado vai na outra visão: o centro
// fica com os commits e o diff, que é o que precisa de largura.
function desenharTrilhaImplantacao(d) {
  document.getElementById('trilha-corpo').innerHTML = `
    <div class="tr-secao">
      <div class="tr-titulo">Release</div>
      <div class="impl-tr-repo">${esc(d.projeto)}</div>
      <div class="impl-tr-depara"><code>${esc(d.origem)}</code> → <code>${esc(d.destino)}</code></div>
    </div>
    <div class="tr-secao">
      <div class="tr-titulo">O que entra</div>
      <div class="impl-tr-nums">
        <div><b>${d.commits}</b><span>commits</span></div>
        <div><b>${d.arquivos}</b><span>arquivos</span></div>
        <div><b class="mais">+${d.adicionadas}</b><span>linhas</span></div>
        <div><b class="menos">-${d.removidas}</b><span>linhas</span></div>
      </div>
      ${d.migrates.length ? `<div class="impl-tr-alerta" title="${esc(d.migrates.join(' · '))}">
          ${d.migrates.length} migrate(s) — rodar antes do serviço</div>` : ''}
      ${d.pacote ? '<div class="impl-tr-alerta">mexe em package.json</div>' : ''}
    </div>
    <div class="tr-secao">
      <div class="tr-titulo">Chamados <span class="tr-conta">${d.ids.length}</span></div>
      <div class="impl-tr-ids">${d.ids.map(id =>
    `<a class="impl-id" href="${urlDoLinear(id)}" target="_blank" rel="noopener">${id} ↗</a>`).join('')
    || '<div class="tr-nota">nenhum ID nos títulos dos commits</div>'}</div>
    </div>
    <div class="tr-secao">
      <div class="tr-titulo">Autores <span class="tr-conta">${d.autores.length}</span></div>
      <div class="impl-tr-autores">${d.autores.map(a => `<span>${esc(a)}</span>`).join('')}</div>
    </div>
    <div class="tr-pe">
      <button class="tr-agente" onclick="analisarImplantacao()"
              title="analisa os ${escolhidosImplantacao.size} repos escolhidos — leva minutos">
        <span class="tr-cog" aria-hidden="true">🧙</span><span>analisar a implantação</span>
      </button>
      <button class="tr-ver-analise" id="btn-analise" hidden onclick="abrirModalAnalise()"
              title="abre a última análise do agente">
        <span aria-hidden="true">📄</span><span id="analise-rotulo">ver a análise</span>
      </button>
      <button class="tr-pr-abrir" id="btn-pr" onclick="abrirPrDeRelease('${d.projeto}')"
              title="abre a PR de ${esc(d.origem)} para ${esc(d.destino)} neste repo">
        <span aria-hidden="true">⇧</span><span>abrir PR de release</span>
      </button>
      <div class="tr-pr-nota" id="pr-nota"></div>
    </div>`;
  marcarAnaliseDisponivel();
}

// O botão só aparece quando existe análise para abrir. A corrida fica na tabela `corridas` do
// banco, então sobrevive ao reload e ao reinício — e botão que abre modal vazia é pior que nenhum.
async function marcarAnaliseDisponivel() {
  const c = await api('/api/agente-log', { chamado: 'implantação' });
  analiseAberta = c?.resumo ? c : null;
  const b = document.getElementById('btn-analise');
  if (!b) { return; }
  b.hidden = !analiseAberta;
  if (analiseAberta) {
    document.getElementById('analise-rotulo').textContent = `ver a análise${quando(analiseAberta.fim || analiseAberta.inicio)}`;
  }
}

let analiseAberta = null;

async function abrirModalAnalise() {
  document.getElementById('modal-analise')?.remove();
  const m = document.createElement('dialog');
  m.id = 'modal-analise';
  m.innerHTML = renderModalAnalise(analiseAberta, !analiseAberta);
  m.addEventListener('click', e => { if (e.target === m) { m.close(); } });
  m.addEventListener('close', () => m.remove());
  document.body.appendChild(m);
  m.showModal();
  // Relê sempre: a corrida pode ter terminado com a tela aberta, e o que está em memória é do
  // momento em que a trilha foi desenhada.
  analiseAberta = await api('/api/agente-log', { chamado: 'implantação' });
  m.innerHTML = renderModalAnalise(analiseAberta?.resumo ? analiseAberta : null, false);
}

function renderModalAnalise(c, carregando) {
  const corpo = carregando ? girando(120)
    : c?.resumo ? `<div class="ma-texto">${mdParaHtml(c.resumo, id => (window.LINEAR ? urlDoLinear(id) : null))}</div>`
      : `<p class="vazio">Nenhuma análise ainda. O botão <b>analisar a implantação</b>, aqui ao lado,
         roda o agente sobre os repos escolhidos.</p>`;
  const meta = c && !carregando ? [
    c.ok === false ? '⚠ terminou com erro' : null,
    c.eventos?.length ? `${c.eventos.length} passo(s)` : null,
    c.segundos ? `${c.segundos}s` : null,
    c.modelo ? `${esc(c.modelo)} esforço ${esc(c.esforco || '?')}` : null,
    c.fim ? new Date(c.fim).toLocaleString('pt-BR') : null
  ].filter(Boolean).join(' · ') : '';
  return `<div class="me-cabeca">
      <div><div class="me-titulo">🧙 Análise da implantação</div>
        <div class="me-sub">${meta || 'o que o agente achou que eu preciso saber antes de mesclar'}</div></div>
      <button class="pa-fechar" onclick="document.getElementById('modal-analise').close()" title="fechar (Esc)">×</button>
    </div>
    <div class="ma-corpo">${corpo}</div>
    <div class="ma-pe">
      <span>O texto é do agente — confira o que ele afirma antes de mesclar.</span>
      ${c?.resumo ? '<button class="me-copiar" onclick="copiarAnalise()">copiar</button>' : ''}
    </div>`;
}

async function copiarAnalise() {
  await navigator.clipboard.writeText(analiseAberta?.resumo || '');
  avisarNaTela('análise copiada');
}

// Abrir PR é ação para fora e exige confirmação explícita — a mesma regra do commit e do push. O
// título e o corpo saem do detalhe, no servidor: texto montado no navegador seria conteúdo não
// conferido indo para o repositório.
async function abrirPrDeRelease(projeto) {
  const d = filaImplantacao.find(f => f.projeto === projeto)?.detalhe;
  const resumo = d ? `${d.commits} commits, ${d.arquivos} arquivos, ${d.ids.length} chamado(s)` : '';
  if (!confirm(`Abrir a PR de release em ${projeto}?\n\nstage → main\n${resumo}\n\n`
      + 'Isto cria uma pull request de verdade no GitHub.')) {
    return;
  }
  const nota = document.getElementById('pr-nota');
  const botao = document.getElementById('btn-pr');
  if (botao) {
    botao.disabled = true;
  }
  if (nota) {
    nota.className = 'tr-pr-nota';
    nota.textContent = 'abrindo…';
  }
  const r = await api('/api/implantacao-pr', { projeto });
  if (botao) {
    botao.disabled = false;
  }
  if (!nota) {
    return;
  }
  nota.className = `tr-pr-nota ${r.ok ? 'ok' : 'erro'}`;
  nota.innerHTML = r.url
    ? `<a href="${r.url}" target="_blank" rel="noopener">${r.ok ? 'PR aberta' : esc(r.erro)} ↗</a>`
    : esc(r.erro || 'não consegui abrir');
}

async function abrirImplantacao(projeto) {
  const d = await api('/api/implantacao-detalhe', { projeto });
  if (d.erro) {
    return;
  }
  for (const l of document.querySelectorAll('.impl-linha')) {
    l.classList.toggle('ativo', l.dataset.p === projeto);
  }
  atual = { projeto, chamado: null, ref: d.origem, base: d.base, implantacao: true, botao: null };
  implAtual = d;
  // O cabeçalho é do chamado e some; a trilha FICA, com o conteúdo desta visão — é onde o metadado
  // vive na tela de chamados, e o centro continua sendo o diff.
  document.getElementById('cabecalho').hidden = true;
  document.getElementById('trilha').hidden = false;
  desenharTrilhaImplantacao(d);
  const alvo = document.getElementById('conteudo');
  alvo.className = '';
  document.querySelector('main').scrollTop = 0;
  alvo.innerHTML = `
    <div class="impl-cabeca">
      <h2>${esc(projeto)}</h2>
      <span class="impl-de-para">${esc(d.origem)} → ${esc(d.destino)}</span>
    </div>
    <h3 class="secao">Commits <span class="carimbo">${(d.primeiroCommit || '').slice(0, 10)} a ${(d.ultimoCommit || '').slice(0, 10)}</span></h3>
    <div class="impl-commits">${d.listaDeCommits.map(linhaDeCommit).join('')}</div>
    <h3 class="secao" id="titulo-diff-impl"></h3>
    <div id="arquivos" aria-busy="true">${esqCodigo(6)}</div>`;
  await verRelease();
}

// A linha do commit é um botão porque ela ABRE algo — e sem parecer botão ninguém descobriria que
// dá para clicar. Commit raiz (sem pai) fica inerte: não existe "o diff dele" contra nada.
function linhaDeCommit(c) {
  const merge = c.pais.length > 1;
  const dica = c.pais.length
    ? `${merge ? 'merge: o que ele trouxe, contra o 1º pai' : 'ver só o diff deste commit'} (${c.pais[0]})`
    : 'commit raiz — não há pai com que comparar';
  return `<button class="impl-commit${merge ? ' merge' : ''}" data-h="${c.hash}"
      ${c.pais.length ? `onclick="verCommit('${c.hash}')"` : 'disabled'} title="${esc(dica)}">
      <code>${c.hash}</code>
      <span class="impl-titulo">${esc(c.titulo)}</span>
      <span class="impl-autor">${esc(c.autor)}</span>
      <span class="impl-data">${c.data.slice(0, 10)}</span></button>`;
}

// Clicar de novo no commit aberto volta para o release: é o mesmo gesto de fechar, e sem isso o
// único caminho de volta seria um botão que some junto com o diff que ele desfaz.
async function verCommit(hash) {
  const c = implAtual?.listaDeCommits.find(x => x.hash === hash);
  if (!c || !c.pais.length) { return; }
  if (commitAberto === hash) { return verRelease(); }
  commitAberto = hash;
  await trocarDiffDaImplantacao(c.pais[0], hash,
    `Diff do commit <code>${hash}</code> <span class="impl-assunto">${esc(c.titulo)}</span>
     <button class="impl-voltar" onclick="verRelease()">↩ voltar ao release</button>`,
    `${hash} contra o pai ${c.pais[0]}`);
}

async function verRelease() {
  commitAberto = null;
  await trocarDiffDaImplantacao(implAtual.base, implAtual.origem, 'Diff — antes | depois', null);
}

async function trocarDiffDaImplantacao(base, ref, titulo, fonte) {
  const cabeca = document.getElementById('titulo-diff-impl');
  const caixa = document.getElementById('arquivos');
  if (!cabeca || !caixa) { return; }
  for (const l of document.querySelectorAll('.impl-commit')) {
    l.classList.toggle('aberto', l.dataset.h === commitAberto);
  }
  cabeca.innerHTML = `${titulo} <span class="carimbo" id="carimbo"></span>`;
  caixa.className = '';
  caixa.innerHTML = esqCodigo(6);
  // `atual` é o que /api/arquivo lê ao abrir cada arquivo. Sem trocar base e ref aqui, o cabeçalho
  // diria "commit X" e o corpo de cada arquivo viria do release inteiro.
  atual.base = base;
  atual.ref = ref;
  const geracao = ++geracaoDiffImpl;
  const arq = await api('/api/arquivos', { projeto: implAtual.projeto, ref, base });
  if (geracao !== geracaoDiffImpl) { return; }
  atual.dados = arq;
  montarArquivos(arq);
  marcarCarimbo(arq, fonte);
}

async function analisarImplantacao() {
  const projetos = [...escolhidosImplantacao];
  if (!projetos.length) {
    return;
  }
  estadoAgente = { rodando: 'implantação', passos: 0 };
  redesenharAgenteNoTopo();
  painelAgente(`analisando a implantação de ${projetos.length} repo(s)…`, 'inicio');
  const r = await api('/api/agente-implantacao', { projetos: projetos.join(',') });
  if (!r.ok) {
    painelAgente(r.erro || 'não consegui iniciar', 'erro');
  }
}

// ---------- as duas seções da barra ----------

// Três visões na mesma barra: chamados (o trabalho de agora), implantação (o acumulado indo para
// main) e configurações. O título e o pé acompanham, e a trilha só existe na de chamados.
const TITULOS = {
  chamados: ['🧙', 'Magias do Mago', 'conferência por chamado'],
  implantacao: ['🚀', 'Implantação', 'o que vai de stage para main'],
  config: ['⚙', 'Configurações', 'as rotinas que eu sigo']
};

// Trocar de seção esvazia a outra. Recolher só escondia: a lista de chamados continuava montada
// com o chamado anterior marcado como ativo, e ao voltar a seção reabria mostrando a seleção velha
// enquanto o centro já era de outra coisa. Duas verdades ao mesmo tempo na mesma tela.
function limparSecao(tipo) {
  if (tipo === 'implantacao') {
    const painel = document.getElementById('painel-implantacao');
    if (painel) {
      painel.innerHTML = '';
    }
    // A escolha de repos NÃO é limpa: ela vive em disco e é a sessão de trabalho da pessoa. O que
    // se limpa é o desenho e o repo aberto, não a decisão.
    implAtual = null;
    commitAberto = null;
    return;
  }
  for (const l of document.querySelectorAll('.linha-chamado.ativo')) {
    l.classList.remove('ativo');
  }
}

function trocarVisao(qual) {
  if (qual === 'config' && visao !== 'config') {
    visaoAnterior = visao;
  }
  visao = qual;
  // A sanfona reflete a visão. Ela chamava `trocarVisao` e nunca era chamada por ele: sair da
  // Implantação para as Configurações e voltar deixava o título e o centro em "Chamados" com a
  // seção de Implantação aberta na barra, listando 11 repos. Duas seções, duas respostas.
  sincronizarSanfona(qual);
  const emConfig = qual === 'config';
  const [icone, nome, sub] = TITULOS[qual] || TITULOS.chamados;
  document.getElementById('titulo-barra').innerHTML =
    `<span class="mago" aria-hidden="true">${icone}</span>
     <span><span class="nome">${nome}</span><span class="sub">${sub}</span></span>`;
  document.getElementById('painel-config').hidden = !emConfig;
  document.getElementById('sanfona-chamados').hidden = emConfig;
  document.getElementById('sanfona-implantacao').hidden = emConfig;
  document.getElementById('btn-config').classList.toggle('ativa', emConfig);
  document.getElementById('cabecalho').hidden = emConfig || qual === 'implantacao';
  document.getElementById('trilha').hidden = emConfig;
  if (emConfig) {
    carregarConfigs();
    return;
  }
  if (qual === 'implantacao') {
    // Limpar o CENTRO e a TRILHA também, não só a barra. Sem isto a tela mostrava o título
    // "Implantação" à esquerda, os cartões e o diff do chamado no meio, e a trilha do chamado à
    // direita — três verdades diferentes ao mesmo tempo, e a do meio era a mais convincente.
    limparCentro('Escolha um repositório à esquerda para ver o que vai para a <code>main</code>.');
    carregarImplantacao();
    return;
  }
  limparCentro('Escolha um chamado à esquerda.');
  if (chamados.length) {
    abrirChamado(chamados[0].chamado);
  }
}

// O centro, a trilha e o endereço voltam ao neutro juntos. O endereço entra na conta porque ele é
// estado de verdade aqui: a URL guarda `chamado` e `projeto` e é ela que restaura a tela no
// recarregamento — deixá-la apontando para um chamado depois de trocar de seção significava que
// recarregar desfazia a troca em silêncio.
function limparCentro(aviso) {
  // Invalida o que está EM VOO. As buscas do chamado (`/api/qualidade-remoto` e companhia) são
  // guardadas por geração, e sem incrementá-la aqui a resposta atrasada passava pela guarda e
  // escrevia num `atual` que já era nulo: "Cannot set properties of null (setting 'pr')".
  geracao++;
  atual = null;
  implAtual = null;
  commitAberto = null;
  itensDoAtual = { locais: [], remotos: [], pontos: [], lint: [] };
  const trilha = document.getElementById('trilha');
  trilha.hidden = true;
  document.getElementById('trilha-corpo').innerHTML = '';
  document.getElementById('cabecalho').innerHTML = '';
  const alvo = document.getElementById('conteudo');
  alvo.className = 'aviso';
  alvo.innerHTML = aviso;
  const q = new URLSearchParams(location.search);
  q.delete('chamado');
  q.delete('projeto');
  history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}`);
}

// Sanfona: abrir uma seção fecha a outra. Duas listas longas abertas ao mesmo tempo numa barra de
// 300 px dariam rolagem dupla — e elas respondem perguntas diferentes, raramente ao mesmo tempo.
function sincronizarSanfona(qual) {
  if (sincronizandoSanfona || qual === 'config') {
    return;
  }
  sincronizandoSanfona = true;
  for (const [id, tipo] of SECOES_SANFONA) {
    const el = document.getElementById(id);
    const deveAbrir = tipo === qual;
    if (!deveAbrir && el.open) {
      limparSecao(tipo);
    }
    el.open = deveAbrir;
  }
  sincronizandoSanfona = false;
  // Lembra a seção aqui e não só no clique: quem sai pelas Configurações e volta pelo botão trocou
  // de seção sem tocar na sanfona, e sem isto o próximo carregamento reabria a seção errada.
  try { localStorage.setItem('sanfona', qual); } catch { /* aba privada */ }
}

function ligarSanfona() {
  for (const [id, qual] of SECOES_SANFONA) {
    const el = document.getElementById(id);
    el.addEventListener('toggle', () => {
      if (!el.open || sincronizandoSanfona) {
        return;
      }
      trocarVisao(qual);
      try { localStorage.setItem('sanfona', qual); } catch { /* aba privada */ }
    });
  }
  if (localStorage.getItem('sanfona') === 'implantacao') {
    document.getElementById('sanfona-chamados').open = false;
    document.getElementById('sanfona-implantacao').open = true;
  }
}

// Ícone por chave, no cliente: o servidor manda o que o arquivo É (rótulo, resumo, caminho), e
// como ele se desenha é assunto da tela.
const ICONE_CONFIG = { inicio: '🌱', fim: '🏁', regras: '📏', repos: '🗂' };

async function carregarConfigs() {
  const r = await api('/api/configs', {});
  // Dois grupos, porque são duas naturezas: o que eu LEIO como instrução (markdown, texto livre) e
  // o que eu CONSULTO como dado (catálogo, campos fixos). Juntar tudo numa lista fazia o
  // "Repositórios" parecer mais uma rotina.
  const item = (chave, rotulo, resumo, caminho, aberta) => `
    <button class="item-config" data-k="${chave}" onclick="${aberta}">
      <span class="ic-config" aria-hidden="true">${ICONE_CONFIG[chave] || '📄'}</span>
      <span class="ic-texto">
        <span class="rot">${esc(rotulo)}</span>
        <span class="res">${esc(resumo)}</span>
        <span class="cam">${esc(caminho)}</span>
      </span>
    </button>`;
  document.getElementById('painel-config').innerHTML = `
    <button class="voltar-config" onclick="trocarVisao(visaoAnterior)">
      <span aria-hidden="true">←</span><span>voltar ${
    visaoAnterior === 'implantacao' ? 'à implantação' : 'aos chamados'}</span>
    </button>
    <div class="grupo-config">O que eu sigo</div>
    ${(r.configs || []).map(c => item(c.chave, c.rotulo, c.resumo, c.caminho,
    `abrirConfig('${c.chave}')`)).join('')}
    <div class="grupo-config">Catálogo</div>
    ${item('repos', 'Repositórios', 'Quais entram na comparação de implantação, e com qual par de branches',
    'qualidade.db · tabela repos', 'abrirRepos()')}`;
  const primeiro = document.querySelector('.item-config');
  if (primeiro && !document.querySelector('.item-config.ativo')) {
    abrirConfig(primeiro.dataset.k);
  }
}

let catalogoRepos = [];

// Tabela e não markdown: aqui os campos SÃO previsíveis (repo, origem, destino, entra ou não), e
// digitar JSON à mão para ligar um repo seria pior que o problema que isto resolve.
async function abrirRepos() {
  document.querySelectorAll('.item-config').forEach(b => b.classList.toggle('ativo', b.dataset.k === 'repos'));
  const alvo = document.getElementById('conteudo');
  alvo.className = '';
  alvo.innerHTML = girando(240);
  const r = await api('/api/repos', {});
  catalogoRepos = r.repos || [];
  if (!catalogoRepos.length) {
    // Primeira abertura, catálogo vazio: detectar sozinho é o certo — a alternativa é uma tabela
    // vazia com um botão, e ninguém quer configurar 51 repos à mão para começar.
    const d = await api('/api/repos-detectar', {});
    catalogoRepos = d.repos || [];
  }
  desenharRepos(r.detectadoEm);
}

function desenharRepos(detectadoEm) {
  if (detectadoEm !== undefined) {
    detectadoEmRepos = detectadoEm;
  }
  // O índice original viaja junto: as linhas são partidas em duas seções, e `mexerNoRepo` endereça
  // pela posição no array. Reindexar por seção trocaria a linha editada pela vizinha.
  const comIndice = catalogoRepos.map((r, i) => ({ r, i }));
  const comPar = comIndice.filter(({ r }) => r.origem && r.destino);
  const semPar = comIndice.filter(({ r }) => !r.origem || !r.destino);
  const ativos = catalogoRepos.filter(r => r.ativo).length;
  document.getElementById('conteudo').innerHTML = `
    <header class="cab-repos">
      <div class="cab-titulo-bloco">
        <h2>Repositórios</h2>
        <span class="carimbo">${ativos} entram na comparação · ${catalogoRepos.length} pastas com
          <code>.git</code>${detectadoEmRepos
      ? ` · detectado ${new Date(detectadoEmRepos).toLocaleString('pt-BR')}` : ''}</span>
      </div>
      <button class="bt-secundario" onclick="detectarRepos()"
              title="relê as branches do .git de cada pasta">⟳ detectar de novo</button>
      <button class="bt-primario" onclick="salvarRepos()">salvar</button>
      <span class="selo pr-carregando" id="estado-repos">sem alteração</span>
    </header>
    <p class="dica">A fila de implantação percorre só o que está <b>marcado</b>, comparando
      <b>origem → destino</b> de cada linha. <b>Detectar de novo</b> relê as branches do
      <code>.git</code> e reescreve as linhas automáticas — o que você editar à mão vira
      <b class="fonte-manual">manual</b> e a detecção não encosta.</p>

    <div class="repos-filtro">
      <input id="filtro-repos" placeholder="filtrar por nome…" spellcheck="false"
             oninput="filtrarRepos(this.value)">
      <span class="repos-conta" id="conta-filtro"></span>
    </div>

    <table class="tab-repos">
      <thead><tr>
        <th class="c-entra">entra</th><th class="c-nome">repositório</th>
        <th class="c-par">compara</th><th class="c-fonte"></th><th class="c-tirar"></th>
      </tr></thead>
      <tbody id="corpo-repos">${comPar.map(({ r, i }) => linhaDeRepo(r, i)).join('')}</tbody>
    </table>

    ${semPar.length ? `<details class="repos-sem-par">
      <summary>${semPar.length} pasta(s) sem par de branches — não entram na comparação</summary>
      <table class="tab-repos">
        <tbody>${semPar.map(({ r, i }) => linhaDeRepo(r, i)).join('')}</tbody>
      </table>
    </details>` : ''}

    <div class="repos-novo">
      <span class="rn-rot">Adicionar à mão</span>
      <input id="novo-repo" placeholder="pasta do repositório" spellcheck="false">
      <input id="novo-origem" placeholder="origin/stage" spellcheck="false">
      <span class="rn-seta" aria-hidden="true">→</span>
      <input id="novo-destino" placeholder="origin/main" spellcheck="false">
      <button onclick="adicionarRepo()">adicionar</button>
    </div>`;
  filtrarRepos(filtroRepos);
}

function linhaDeRepo(r, i) {
  const sem = !r.origem || !r.destino;
  // Origem e destino num campo só, com a seta no meio: é UM par de branches, e duas colunas soltas
  // faziam ler como dois dados independentes. E nada de selo "detectado" — ele apareceria em 36 das
  // 51 linhas, e selo que está em quase tudo não informa nada. Só o manual é exceção.
  return `<tr class="${r.ativo ? '' : 'apagada'}${sem ? ' sem-par' : ''}" data-p="${esc(r.projeto)}">
    <td class="c-entra">${sem
    ? `<span class="c-vazio" title="${esc(r.motivo || 'sem par de branches')}">—</span>`
    : `<input type="checkbox" ${r.ativo ? 'checked' : ''}
        onchange="mexerNoRepo(${i}, 'ativo', this.checked)">`}</td>
    <td class="c-nome">${esc(r.projeto)}</td>
    <td class="c-par">
      <span class="par-campos">
        <input value="${esc(r.origem || '')}" placeholder="origin/stage" spellcheck="false"
          onchange="mexerNoRepo(${i}, 'origem', this.value)">
        <span class="par-seta" aria-hidden="true">→</span>
        <input value="${esc(r.destino || '')}" placeholder="origin/main" spellcheck="false"
          onchange="mexerNoRepo(${i}, 'destino', this.value)">
      </span>
      ${sem ? `<span class="c-motivo">${esc(r.motivo || '')}</span>` : ''}</td>
    <td class="c-fonte">${r.fonte === 'manual' ? '<span class="selo-fonte">manual</span>' : ''}</td>
    <td class="c-tirar"><button class="tr-tirar" onclick="removerRepo(${i})"
        title="tira ${esc(r.projeto)} do catálogo">×</button></td>
  </tr>`;
}

let filtroRepos = '';
let detectadoEmRepos = null;

// Esconde linha em vez de redesenhar a tabela: redesenhar a cada tecla tiraria o foco do campo de
// filtro no meio da digitação.
function filtrarRepos(texto) {
  filtroRepos = texto || '';
  const busca = filtroRepos.trim().toLowerCase();
  let vendo = 0;
  for (const linha of document.querySelectorAll('.tab-repos tbody tr')) {
    const casa = !busca || linha.dataset.p.toLowerCase().includes(busca);
    linha.hidden = !casa;
    if (casa) {
      vendo++;
    }
  }
  const conta = document.getElementById('conta-filtro');
  if (conta) {
    conta.textContent = busca ? `${vendo} de ${catalogoRepos.length}` : '';
  }
  // Com filtro ativo, a seção recolhida abre: esconder o que casou com a busca dentro de um
  // `<details>` fechado é o mesmo que dizer que não existe.
  const dobra = document.querySelector('.repos-sem-par');
  if (dobra && busca) {
    dobra.open = true;
  }
}

// Quem MUDOU, por nome. A rota deixou de aceitar a lista inteira de propósito: mandar tudo é o
// pedido destrutivo que apagava a edição da outra aba — duas abas, a segunda salva a cópia velha,
// a primeira edição some sem erro. Aqui a tela passa a dizer o que mudou, uma linha por vez.
const reposEditados = new Set();
const reposRemovidos = new Set();

function mexerNoRepo(i, campo, valor) {
  catalogoRepos[i][campo] = typeof valor === 'string' ? valor.trim() || null : valor;
  reposEditados.add(catalogoRepos[i].projeto);
  reposSujos();
}

function removerRepo(i) {
  const [fora] = catalogoRepos.splice(i, 1);
  if (!fora) {
    return;
  }
  reposEditados.delete(fora.projeto);
  // Linha acrescentada nesta sessão e ainda não salva só existiu aqui: não há o que remover lá.
  if (fora.jaSalvo !== false) {
    reposRemovidos.add(fora.projeto);
  }
  desenharRepos();
  reposSujos();
}

function adicionarRepo() {
  const projeto = document.getElementById('novo-repo').value.trim();
  if (!projeto) {
    return;
  }
  if (catalogoRepos.some(r => r.projeto === projeto)) {
    return avisarNaTela(`${projeto} já está na lista`);
  }
  const origem = document.getElementById('novo-origem').value.trim() || 'origin/stage';
  const destino = document.getElementById('novo-destino').value.trim() || 'origin/main';
  catalogoRepos.push({ projeto, origem, destino, fonte: 'manual', ativo: true, motivo: null, jaSalvo: false });
  reposEditados.add(projeto);
  catalogoRepos.sort((a, b) => a.projeto.localeCompare(b.projeto));
  desenharRepos();
  reposSujos();
}

function reposSujos() {
  const e = document.getElementById('estado-repos');
  if (e) {
    e.className = 'selo pr-sem-pr';
    e.textContent = 'não salvo';
  }
}

const pedirAoCatalogo = corpo => fetch(`/api/repos-salvar${window.TOKEN ? `?t=${window.TOKEN}` : ''}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(corpo)
}).then(x => x.json()).catch(x => ({ erro: x.message }));

async function salvarRepos() {
  const e = document.getElementById('estado-repos');
  const editados = [...reposEditados];
  const removidos = [...reposRemovidos];
  if (!editados.length && !removidos.length) {
    e.className = 'selo pr-carregando';
    e.textContent = 'nada mudou';
    return;
  }
  e.className = 'selo pr-carregando';
  e.textContent = `salvando ${editados.length + removidos.length}…`;
  // Um pedido por linha. Parece mais chamada do que antes e é — mas cada uma nomeia o seu alvo, e
  // duas abas editando repos diferentes agora convivem em vez de uma apagar a outra.
  const respostas = await Promise.all([
    ...editados.map(projeto => {
      const r = catalogoRepos.find(x => x.projeto === projeto);
      if (!r) {
        return Promise.resolve({});
      }
      const { jaSalvo, ...linha } = r;
      return pedirAoCatalogo({ repo: linha });
    }),
    ...removidos.map(projeto => pedirAoCatalogo({ remover: projeto }))
  ]);
  const falhou = respostas.find(r => r.erro);
  if (falhou) {
    e.className = 'selo pr-sem-pr';
    e.textContent = `erro: ${falhou.erro}`;
    return;
  }
  reposEditados.clear();
  reposRemovidos.clear();
  // Relê do servidor em vez de confiar na cópia local: outra aba pode ter mexido em linhas que
  // não são minhas, e é justamente isso que agora sobrevive.
  const atualizado = await api('/api/repos', {});
  catalogoRepos = atualizado.repos || [];
  desenharRepos(atualizado.detectadoEm);
  // A fila do menu vem do catálogo: salvar sem recarregá-la deixava a barra mostrando repos que
  // acabaram de sair da comparação.
  carregarImplantacao();
  avisarNaTela(`${editados.length} salvo(s)${removidos.length ? `, ${removidos.length} removido(s)` : ''}`
    + ` · ${catalogoRepos.filter(x => x.ativo).length} na comparação`);
}

async function detectarRepos() {
  const alvo = document.getElementById('conteudo');
  alvo.innerHTML = girando(240);
  const r = await api('/api/repos-detectar', {});
  // A detecção reescreveu o catálogo no servidor: edição pendente daqui virou passado.
  reposEditados.clear();
  reposRemovidos.clear();
  catalogoRepos = r.repos || [];
  desenharRepos(r.detectadoEm);
  carregarImplantacao();
  avisarNaTela(`${catalogoRepos.filter(x => x.ativo).length} de ${catalogoRepos.length} com par de branches`);
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
  recarregar, ocultar, mostrar, tirarPonto, pedirAoAgente, irParaRepo, abrirModalEstado, copiarCorrida,
  alternarRepo, abrirImplantacao, analisarImplantacao, abrirPrDeRelease, verCommit, verRelease,
  abrirModalAnalise, copiarAnalise, atualizarImplantacao,
  copiarLink,
  trocarVisao, abrirConfig, salvarConfig,
  abrirRepos, detectarRepos, salvarRepos, mexerNoRepo, removerRepo, adicionarRepo, filtrarRepos
});
// Lidas pelos onclick da engrenagem e do botão de voltar, que moram no HTML.
Object.defineProperty(window, 'visao', { get: () => visao });
Object.defineProperty(window, 'visaoAnterior', { get: () => visaoAnterior });

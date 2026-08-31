// Realce de sintaxe próprio: as linguagens deste workspace são conhecidas e um tokenizador de ~150
// linhas cobre o que se precisa. CDN quebraria offline e vendorizar highlight.js seria 100 KB para
// realçar 40 linhas por vez.
//
// O estado (dentro de bloco de comentário / string longa) atravessa as linhas, porque `/* */` e as
// docstrings do Python não cabem numa linha só. Na lacuna o estado é zerado: errar limitado é melhor
// que pintar o resto do arquivo como comentário.

const PALAVRAS = {
  js: 'await async break case catch class const continue default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while yield',
  py: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda none nonlocal not or pass raise return try while with yield self True False None',
  java: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static super switch synchronized this throw throws transient try void volatile while var record',
  sql: 'select from where join left right inner outer on group by order having union all insert into values update set delete create table alter drop index as and or not null is like in exists case when then else end distinct limit offset with',
  sh: 'if then else elif fi for while do done case esac function return export local readonly set unset echo cd source alias',
  css: '',
  json: 'true false null',
  yaml: 'true false null yes no on off',
  markup: ''
};

const PORTA_EXTENSAO = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js',
  py: 'py', java: 'java', json: 'json', css: 'css', scss: 'css', less: 'css',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup',
  yml: 'yaml', yaml: 'yaml', sql: 'sql', sh: 'sh', zsh: 'sh', bash: 'sh'
};

const COMENTARIO_LINHA = { js: '//', java: '//', py: '#', yaml: '#', sh: '#', sql: '--', css: null, json: null, markup: null };
const BLOCO = {
  js: [/\/\*/, /\*\//], java: [/\/\*/, /\*\//], css: [/\/\*/, /\*\//],
  markup: [/<!--/, /-->/], py: [/"""|'''/, /"""|'''/]
};

export function linguagemDe(caminho) {
  const ext = (caminho.split('.').pop() || '').toLowerCase();
  return PORTA_EXTENSAO[ext] || null;
}

function escapar(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function span(classe, texto) {
  return `<span class="t-${classe}">${escapar(texto)}</span>`;
}

export function novoEstado() {
  return { emBloco: false, fecha: null };
}

// Uma passada por linha, consumindo o maior token possível em cada posição.
export function realcar(texto, ling, estado) {
  if (!ling || !texto) {
    return escapar(texto);
  }
  const chaves = new Set(PALAVRAS[ling].split(' ').filter(Boolean));
  const bloco = BLOCO[ling];
  const marcaLinha = COMENTARIO_LINHA[ling];
  let saida = '';
  let i = 0;

  if (estado.emBloco && bloco) {
    const fim = texto.match(estado.fecha || bloco[1]);
    if (!fim) {
      return span('comentario', texto);
    }
    const corte = fim.index + fim[0].length;
    saida += span('comentario', texto.slice(0, corte));
    estado.emBloco = false;
    i = corte;
  }

  while (i < texto.length) {
    const resto = texto.slice(i);

    if (bloco) {
      const abre = resto.match(bloco[0]);
      if (abre && abre.index === 0) {
        const fim = resto.slice(abre[0].length).match(bloco[1]);
        if (fim) {
          const corte = abre[0].length + fim.index + fim[0].length;
          saida += span('comentario', resto.slice(0, corte));
          i += corte;
          continue;
        }
        estado.emBloco = true;
        estado.fecha = bloco[1];
        saida += span('comentario', resto);
        return saida;
      }
    }

    if (marcaLinha && resto.startsWith(marcaLinha)) {
      saida += span('comentario', resto);
      return saida;
    }

    const str = resto.match(/^(?:`(?:\\.|[^`\\])*`?|'(?:\\.|[^'\\])*'?|"(?:\\.|[^"\\])*"?)/);
    if (str) {
      saida += span('texto', str[0]);
      i += str[0].length;
      continue;
    }

    // Decorator do Python, anotação do Java, diretiva do AngularJS
    const marca = resto.match(/^@[\w.$-]+/);
    if (marca) {
      saida += span('marca', marca[0]);
      i += marca[0].length;
      continue;
    }

    if (ling === 'markup') {
      const tag = resto.match(/^<\/?[\w:.-]+/);
      if (tag) {
        saida += span('tipo', tag[0]);
        i += tag[0].length;
        continue;
      }
      const atr = resto.match(/^[\w:.-]+(?==)/);
      if (atr) {
        saida += span('propriedade', atr[0]);
        i += atr[0].length;
        continue;
      }
    }

    const num = resto.match(/^(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/);
    if (num) {
      saida += span('numero', num[0]);
      i += num[0].length;
      continue;
    }

    const ident = resto.match(/^[A-Za-z_$][\w$]*/);
    if (ident) {
      const nome = ident[0];
      const depois = resto.slice(nome.length);
      let classe;
      if (chaves.has(nome) || chaves.has(nome.toLowerCase()) && (ling === 'sql' || ling === 'sh')) {
        classe = 'chave';
      } else if (/^\s*\(/.test(depois)) {
        classe = 'funcao';
      } else if (/^\s*:/.test(depois) && ling !== 'js') {
        classe = 'propriedade';
      } else if (/^\s*:/.test(depois)) {
        classe = 'propriedade';
      } else if (/^[A-Z]/.test(nome)) {
        classe = 'tipo';
      }
      saida += classe ? span(classe, nome) : escapar(nome);
      i += nome.length;
      continue;
    }

    const op = resto.match(/^[=+\-*/%<>!&|^~?:]+/);
    if (op) {
      saida += span('operador', op[0]);
      i += op[0].length;
      continue;
    }

    saida += escapar(resto[0]);
    i++;
  }
  return saida;
}

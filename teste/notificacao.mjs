// O aviso do sistema quando o mago ou o juiz termina. Nenhum caso aqui mostra notificação de verdade:
// o comando é capturado, e o que se trava é quando ele roda e a forma dos argumentos.
//
// uso: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avisoDoSistema } from '../lib/notificacao.mjs';

const capturar = () => {
    const chamadas = [];
    return { chamadas, rodar: (exe, args, fim) => { chamadas.push({ exe, args }); fim?.(); } };
};
const noMac = extra => ({ plataforma: 'darwin', desligado: false, ...extra });

test('o fim do mago e o do juiz avisam, com som; o andamento não', () => {
    const c = capturar();
    avisoDoSistema({ tipo: 'agente', fase: 'andando', chamado: 'UND-1', texto: 'lendo' }, noMac(c));
    assert.equal(c.chamadas.length, 0);
    const mago = avisoDoSistema({ tipo: 'agente', fase: 'fim', chamado: 'UND-1', ok: true, texto: 'terminou' }, noMac(c));
    const juiz = avisoDoSistema({ tipo: 'juiz', fase: 'fim', chamado: 'UND-1', projeto: 'crohc-server', veredito: 'APPROVE' }, noMac(c));
    assert.equal(c.chamadas.length, 2);
    assert.equal(c.chamadas[0].exe, 'osascript');
    assert.match(c.chamadas[0].args.join(' '), /sound name "Glass"/);
    assert.equal(mago.titulo, '🧙 O mago terminou');
    assert.equal(juiz.corpo, 'UND-1 · crohc-server · APPROVE');
});

test('texto do agente vai como argumento, nunca dentro do AppleScript', () => {
    const c = capturar();
    const malicioso = '" & do shell script "rm -rf ~" & "';
    avisoDoSistema({ tipo: 'juiz', fase: 'fim', chamado: 'UND-1', texto: malicioso }, noMac(c));
    const { args } = c.chamadas[0];
    const script = args.filter((_, i) => args[i - 1] === '-e');
    assert.ok(script.every(linha => !linha.includes('rm -rf')), 'o texto entrou no código do script');
    assert.ok(args[args.length - 1].includes(malicioso));
});

test('fora do Mac, desligado, ou outro tipo de evento: não roda nada', () => {
    const c = capturar();
    avisoDoSistema({ tipo: 'juiz', fase: 'fim' }, { ...c, plataforma: 'linux', desligado: false });
    avisoDoSistema({ tipo: 'juiz', fase: 'fim' }, { ...c, plataforma: 'darwin', desligado: true });
    avisoDoSistema({ tipo: 'recarregar', fase: 'fim' }, noMac(c));
    assert.equal(c.chamadas.length, 0);
});

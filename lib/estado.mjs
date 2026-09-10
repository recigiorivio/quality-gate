// Estado em JSON, escrito sem deixar rastro pela metade.
//
// O projeto guarda estado em arquivos JSON pequenos — o maior tem 19 KB — e isso é escolha, não
// preguiça: são arquivos que a pessoa edita à mão, que o agente escreve, e que se lê com `grep`.
// O que estava errado era COMO se escrevia. Havia seis escritores, cada um com o seu
// `writeFileSync` por cima do arquivo vivo, e três defeitos que se repetiam em todos:
//
//  1. Escrita não atômica. Crash no meio deixa JSON truncado, e como todo leitor tem
//     `catch { return {} }`, o arquivo corrompido lê como VAZIO — a decisão do agente, a escolha de
//     repos, tudo some sem erro. Aqui a escrita vai para um temporário no mesmo diretório e entra
//     por `rename`, que é indivisível: o leitor vê o conteúdo velho inteiro ou o novo inteiro.
//  2. Gravar o objeto todo. `escolher` apagou o `buscadoEm` que `buscarRemoto` tinha acabado de
//     gravar, porque cada um montava o JSON inteiro do seu jeito. `mesclar` lê, junta e grava.
//  3. Perda silenciosa na leitura. Arquivo ausente e arquivo quebrado davam o mesmo `{}`. Aqui
//     ausente devolve o padrão e QUEBRADO grita: o arquivo ruim é preservado como `.ruim` e o erro
//     sobe, porque continuar com o padrão é apagar o estado da pessoa por cima do defeito.
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

export function ler(arquivo, padrao = {}) {
    if (!existsSync(arquivo)) {
        return padrao;
    }
    const bruto = readFileSync(arquivo, 'utf8');
    try {
        return JSON.parse(bruto);
    } catch (e) {
        const ruim = `${arquivo}.ruim`;
        writeFileSync(ruim, bruto);
        throw new Error(`${basename(arquivo)} não é JSON válido (${e.message}); o conteúdo está em ${basename(ruim)}`);
    }
}

export function gravar(arquivo, dados) {
    // O temporário fica no MESMO diretório: `rename` só é atômico dentro do mesmo sistema de
    // arquivos, e `/tmp` costuma ser outro.
    const temporario = join(dirname(arquivo), `.${basename(arquivo)}.${process.pid}.tmp`);
    try {
        writeFileSync(temporario, `${JSON.stringify(dados, null, 2)}\n`);
        renameSync(temporario, arquivo);
    } catch (e) {
        if (existsSync(temporario)) {
            unlinkSync(temporario);
        }
        throw e;
    }
    return dados;
}

export function mesclar(arquivo, mudanca, padrao = {}) {
    return gravar(arquivo, { ...ler(arquivo, padrao), ...mudanca });
}

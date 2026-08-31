// Confere se um filtro tem índice em stage, e de que tipo são os valores do campo no dado real.
// Os dois erros que esta base já pagou: COLLSCAN silencioso em filtro sobre campo dentro de array,
// e comparação de tipos diferentes (tiss_guia.idArquivo é string, não ObjectId).
//
// uso: node qualidade/ferramentas/indices.mjs <colecao> '<filtro json>' [--pipeline]
//      node qualidade/ferramentas/indices.mjs <colecao> --indices

import stg from '../lib/stg.mjs';

class Indices {
    async listar(db, nome) {
        const indices = await db.collection(nome).indexes();
        console.log(`\níndices de ${nome} (${indices.length}):`);
        for (const i of indices) {
            const parcial = i.partialFilterExpression ? `  parcial: ${JSON.stringify(i.partialFilterExpression)}` : '';
            const unico = i.unique ? '  UNIQUE' : '';
            console.log(`  ${i.name}: ${JSON.stringify(i.key)}${unico}${parcial}`);
        }
        return indices;
    }

    // Tipo do valor no dado real, não o tipo que o código presume.
    async tiposDosCampos(db, nome, filtro) {
        const campos = Object.keys(filtro).filter(k => !k.startsWith('$'));
        if (!campos.length) {
            return;
        }
        console.log('\ntipo dos campos do filtro no dado de stage:');
        for (const campo of campos) {
            const grupos = await db.collection(nome).aggregate([
                { $match: { [campo]: { $exists: true } } },
                { $limit: 2000 },
                { $group: { _id: { $type: `$${campo}` }, n: { $sum: 1 } } },
                { $sort: { n: -1 } }
            ], { maxTimeMS: 20000 }).toArray();
            const esperado = typeof filtro[campo] === 'string' ? 'string' : typeof filtro[campo];
            const visto = grupos.map(g => `${g._id}(${g.n})`).join(' ') || 'campo ausente na amostra';
            const divergente = grupos.length && !grupos.some(g => g._id === esperado || (esperado === 'object' && g._id === 'objectId'));
            console.log(`  ${campo}: ${visto}${divergente ? `   ⚠ filtro passa ${esperado}` : ''}`);
        }
    }

    async explicar(db, nome, filtro, comoPipeline) {
        const colecao = db.collection(nome);
        const cursor = comoPipeline
            ? colecao.aggregate(filtro, { maxTimeMS: 30000 })
            : colecao.find(filtro, { maxTimeMS: 30000 });
        const plano = await cursor.explain('executionStats');
        const stats = plano.executionStats || {};
        const texto = JSON.stringify(plano);
        const collscan = /"stage":"COLLSCAN"/.test(texto);
        const indice = (texto.match(/"indexName":"([^"]+)"/g) || [])
            .map(m => m.split('":"')[1].replace('"', '')).join(', ');

        console.log('\nplano de execução:');
        console.log(`  ${collscan ? '✗ COLLSCAN — varre a coleção inteira' : `✓ IXSCAN — índice: ${indice}`}`);
        console.log(`  retornados: ${stats.nReturned ?? '?'}   examinados: ${stats.totalDocsExamined ?? '?'}   chaves: ${stats.totalKeysExamined ?? '?'}`);
        console.log(`  tempo: ${stats.executionTimeMillis ?? '?'} ms`);
        const razao = stats.nReturned > 0 ? (stats.totalDocsExamined / stats.nReturned) : null;
        if (razao !== null && razao > 10) {
            console.log(`  ⚠ examina ${razao.toFixed(0)}× o que devolve — índice não está seletivo`);
        }
        if (stats.nReturned === 0) {
            console.log('  ⚠ zero resultados: pode ser filtro correto sem dado, ou divergência de tipo acima');
        }
        return { collscan, indice, stats };
    }

    async executar(nome, argumento, comoPipeline) {
        const db = await stg.conectar();
        try {
            await this.listar(db, nome);
            if (argumento === '--indices') {
                return;
            }
            const filtro = JSON.parse(argumento);
            if (!comoPipeline) {
                await this.tiposDosCampos(db, nome, filtro);
            }
            await this.explicar(db, nome, filtro, comoPipeline);
        } finally {
            await stg.fechar();
        }
    }
}

const [nome, argumento, ...resto] = process.argv.slice(2);
if (!nome || !argumento) {
    console.error("uso: node indices.mjs <colecao> '<filtro json>' [--pipeline]\n     node indices.mjs <colecao> --indices");
    process.exit(1);
}
new Indices().executar(nome, argumento, resto.includes('--pipeline'))
    .catch(e => {
        console.error(`erro: ${e.message}`);
        process.exit(1);
    });

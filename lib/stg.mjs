// Conexão de leitura ao MongoDB de stage. Recusa host de produção e qualquer operação de escrita.
// O guard é client-side: não substitui usuário Atlas com role `read`, apenas evita o acidente.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE } from './diff.mjs';

// O driver é reaproveitado de um repo vizinho que já o tem, em vez de virar dependência deste
// projeto. Procura em candidatos conhecidos e diz onde olhou se não achar — presumir um caminho
// absoluto fazia isto funcionar só numa máquina.
const CANDIDATOS_DRIVER = [
    'workflow-admin/server/node_modules/mongodb/lib/index.js',
    'contas-service/node_modules/mongodb/lib/index.js',
    'crohc-server/node_modules/mongodb/lib/index.js',
    'workflow-manager/node_modules/mongodb/lib/index.js',
    'node_modules/mongodb/lib/index.js'
];

async function carregarMongoClient() {
    const tentados = [];
    for (const rel of [...CANDIDATOS_DRIVER, join('..', 'node_modules/mongodb/lib/index.js')]) {
        const caminho = rel.startsWith('/') ? rel : join(WORKSPACE, rel);
        tentados.push(caminho);
        if (existsSync(caminho)) {
            return (await import(caminho)).MongoClient;
        }
    }
    throw new Error(`driver mongodb não encontrado. Procurei em:\n  ${tentados.join('\n  ')}\n`
        + 'Instale com `npm i mongodb` nesta pasta ou aponte QUALIDADE_WORKSPACE para um workspace que já o tenha.');
}

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));
const METODOS_LEITURA = new Set([
    'find', 'findOne', 'countDocuments', 'estimatedDocumentCount',
    'distinct', 'aggregate', 'indexes', 'indexInformation', 'listIndexes'
]);
const HOST_PROIBIDO = /\b(prd|prod|production)\b|prd\.|riviooneprd/i;
const ESTAGIO_DE_ESCRITA = /^\$(out|merge)$/;

class Stg {
    constructor() {
        this.client = null;
    }

    carregarEnv() {
        const arquivo = join(RAIZ, '.env');
        if (!existsSync(arquivo)) {
            throw new Error(`Falta ${arquivo}. Copie o .env.example e preencha STG_MONGODB_URI.`);
        }
        const env = {};
        for (const linha of readFileSync(arquivo, 'utf8').split('\n')) {
            const m = linha.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
            if (m) {
                env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
            }
        }
        return env;
    }

    // A recusa é por host, não por nome de banco: `stg_crohc` num cluster de prd continua sendo prd.
    validarUri(uri) {
        if (!uri) {
            throw new Error('STG_MONGODB_URI vazia.');
        }
        const host = uri.replace(/^mongodb(\+srv)?:\/\/[^@]*@/, '').split(/[/?]/)[0];
        if (HOST_PROIBIDO.test(host)) {
            throw new Error(`Host recusado por parecer produção: ${host}`);
        }
        return host;
    }

    async conectar() {
        const MongoClient = await carregarMongoClient();
        const env = this.carregarEnv();
        const uri = env.STG_MONGODB_URI;
        const host = this.validarUri(uri);
        this.client = new MongoClient(uri, {
            readPreference: 'secondaryPreferred',
            serverSelectionTimeoutMS: Number(env.STG_TIMEOUT_MS || 15000),
            socketTimeoutMS: Number(env.STG_TIMEOUT_MS || 15000)
        });
        await this.client.connect();
        const db = this.client.db(env.STG_MONGODB_DB || 'stg_crohc');
        console.error(`[stg] conectado: ${host}/${db.databaseName} (somente leitura)`);
        return this._protegerDb(db);
    }

    _protegerDb(db) {
        return new Proxy(db, {
            get: (alvo, prop) => {
                if (prop === 'collection') {
                    return nome => this._protegerColecao(alvo.collection(nome), nome);
                }
                if (prop === 'databaseName' || prop === 'listCollections' || prop === 'command') {
                    return typeof alvo[prop] === 'function' ? alvo[prop].bind(alvo) : alvo[prop];
                }
                if (typeof alvo[prop] === 'function') {
                    throw new Error(`db.${String(prop)} bloqueado: só leitura`);
                }
                return alvo[prop];
            }
        });
    }

    _protegerColecao(colecao, nome) {
        return new Proxy(colecao, {
            get: (alvo, prop) => {
                const chave = String(prop);
                if (!METODOS_LEITURA.has(chave)) {
                    throw new Error(`${nome}.${chave} bloqueado: só ${[...METODOS_LEITURA].join(', ')}`);
                }
                if (chave === 'aggregate') {
                    return (pipeline = [], opcoes) => {
                        const escrita = pipeline.find(e => Object.keys(e || {}).some(k => ESTAGIO_DE_ESCRITA.test(k)));
                        if (escrita) {
                            throw new Error(`pipeline com estágio de escrita bloqueado: ${JSON.stringify(escrita)}`);
                        }
                        return alvo.aggregate(pipeline, opcoes);
                    };
                }
                return alvo[chave].bind(alvo);
            }
        });
    }

    async fechar() {
        if (this.client) {
            await this.client.close();
        }
    }
}

export default new Stg();

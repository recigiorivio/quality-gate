// Conexão de leitura ao MongoDB de stage. Recusa host de produção e qualquer operação de escrita.
// O guard é client-side: não substitui usuário Atlas com role `read`, apenas evita o acidente.

import { readdirSync, existsSync } from 'node:fs';
import { lerEnv } from './env.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE } from './diff.mjs';

// O driver é reaproveitado de um repo vizinho que já o tem, em vez de virar dependência deste
// projeto. Procura, não enumera: uma lista de nomes de repo só funcionaria no workspace de quem
// escreveu. Aceita `QUALIDADE_MONGODB` para apontar direto.
const RELATIVO_DRIVER = 'node_modules/mongodb/lib/index.js';
const PROFUNDIDADE = 3;

function candidatosDeDriver() {
    const candidatos = [];
    if (process.env.QUALIDADE_MONGODB) {
        candidatos.push(process.env.QUALIDADE_MONGODB);
    }
    candidatos.push(join(RAIZ, RELATIVO_DRIVER));
    candidatos.push(join(WORKSPACE, RELATIVO_DRIVER));
    // Varre os repos irmãos até 3 níveis: cobre `<repo>/node_modules` e `<repo>/<sub>/node_modules`.
    const fila = [{ dir: WORKSPACE, nivel: 0 }];
    while (fila.length) {
        const { dir, nivel } = fila.shift();
        if (nivel >= PROFUNDIDADE) {
            continue;
        }
        let filhos = [];
        try {
            filhos = readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const f of filhos) {
            if (!f.isDirectory() || f.name.startsWith('.') || f.name === 'node_modules') {
                continue;
            }
            const alvo = join(dir, f.name, RELATIVO_DRIVER);
            if (existsSync(alvo)) {
                candidatos.push(alvo);
            }
            fila.push({ dir: join(dir, f.name), nivel: nivel + 1 });
        }
    }
    return candidatos;
}

async function carregarMongoClient() {
    const candidatos = candidatosDeDriver();
    for (const caminho of candidatos) {
        if (existsSync(caminho)) {
            return (await import(caminho)).MongoClient;
        }
    }
    throw new Error('driver mongodb não encontrado em nenhum repo do workspace.\n'
        + `Procurei sob ${WORKSPACE} (até ${PROFUNDIDADE} níveis).\n`
        + 'Resolva com `npm i mongodb` nesta pasta, ou aponte QUALIDADE_MONGODB para o index.js do driver.');
}

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));
const METODOS_LEITURA = new Set([
    'find', 'findOne', 'countDocuments', 'estimatedDocumentCount',
    'distinct', 'aggregate', 'indexes', 'indexInformation', 'listIndexes'
]);
// Recusa por SUBSTRING, não por palavra: nome de cluster costuma colar o sufixo (`...oneprd`), e um
// `\bprd\b` não pegaria. Erra para o lado de recusar, que é o lado seguro num guard.
// `QUALIDADE_HOSTS_PROIBIDOS` sobrescreve com a sua regex.
const HOST_PROIBIDO = new RegExp(process.env.QUALIDADE_HOSTS_PROIBIDOS || '(prd|prod|production)', 'i');
const ESTAGIO_DE_ESCRITA = /^\$(out|merge)$/;

class Stg {
    constructor() {
        this.client = null;
    }

    carregarEnv() {
        const env = lerEnv(join(RAIZ, '.env'));
        if (!env) {
            throw new Error(`Falta ${join(RAIZ, '.env')}. Copie o .env.example e preencha STG_MONGODB_URI.`);
        }
        return env;
    }

    // A recusa é por host, não por nome de banco: um banco chamado `stg_x` num cluster de produção
    // continua sendo produção.
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
        const db = this.client.db(env.STG_MONGODB_DB || 'admin');
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

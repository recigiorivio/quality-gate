// Grava no cache o que o agente leu do Linear pela sessão dele. O servidor não tem credencial do
// Linear e não vai ter: colocar token de terceiro num projeto sem dependência é dívida.
//
// uso: node qualidade/ferramentas/linear.mjs gravar <ID> '<json>'
//      node qualidade/ferramentas/linear.mjs ver <ID>
//
// O json aceita { titulo, status, atribuido, url, prs: [{titulo, url}] } — é exatamente a forma que
// o `get_issue` do Linear devolve, depois de escolher os campos.

import linear from '../lib/linear.mjs';
import { fileURLToPath } from 'node:url';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [acao, chamado, bruto] = process.argv.slice(2);
    if (acao === 'gravar') {
        if (!chamado || !bruto) {
            console.error("uso: linear.mjs gravar <ID> '<json>'");
            process.exit(1);
        }
        const r = linear.gravar(chamado, JSON.parse(bruto));
        console.log(`${chamado} gravado · ${r.prs.length} PR(s) · ${r.titulo || '(sem título)'}`);
    } else if (acao === 'ver') {
        const d = linear.doChamado(chamado);
        console.log(d ? JSON.stringify(d, null, 2) : 'sem config: crie linear.json com { "workspace": "<slug>" }');
    } else {
        console.error("uso: linear.mjs gravar|ver <ID> ['<json>']");
        process.exit(1);
    }
}

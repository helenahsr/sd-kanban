// Teste de carga do Kanban com k6.
// Rodar: docker compose --profile loadtest run --rm k6
//
// Simula usuários usando o quadro: a maioria só lê (GET /tasks), parte cria,
// move e edita tarefas, e cada usuário apaga as próprias tarefas no fim da iteração
// (mantém o tamanho do quadro estável, senão o GET ficaria mais lento a cada minuto).
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://load-balancer';
const COLUMNS = ['todo', 'doing', 'done'];

export const options = {
    scenarios: {
        usuarios: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '30s', target: 20 },  // aquecimento
                { duration: '1m', target: 20 },   // carga normal
                { duration: '30s', target: 50 },  // subida
                { duration: '1m', target: 50 },   // pico
                { duration: '20s', target: 0 }    // descida
            ],
            gracefulRampDown: '10s'
        }
    },
    thresholds: {
        http_req_failed: ['rate<0.01'],                 // menos de 1% de erro
        http_req_duration: ['p(95)<500'],               // p95 geral abaixo de 500ms
        // Um threshold por endpoint também faz o k6 reportar o p95 de cada um
        'http_req_duration{endpoint:list}': ['p(95)<500'],
        'http_req_duration{endpoint:create}': ['p(95)<500'],
        'http_req_duration{endpoint:move}': ['p(95)<500'],
        'http_req_duration{endpoint:update}': ['p(95)<500'],
        'http_req_duration{endpoint:delete}': ['p(95)<500']
    },
    summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max']
};

// Cada requisição leva um correlation id: dá para achar qualquer uma delas nos logs
function params(endpoint) {
    return {
        headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': `k6-${__VU}-${__ITER}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}` },
        tags: { endpoint },
        timeout: '10s'
    };
}

export default function () {
    // Abre o quadro
    let res = http.get(`${BASE_URL}/tasks`, params('list'));
    check(res, { 'list 200': (r) => r.status === 200 });

    // Cria uma tarefa
    res = http.post(`${BASE_URL}/tasks`, JSON.stringify({
        title: `Carga VU ${__VU} iteração ${__ITER}`,
        assignee: 'k6',
        creator: 'k6',
        priority: 'media',
        status: 'todo'
    }), params('create'));
    if (!check(res, { 'create 201': (r) => r.status === 201 })) return;
    const id = res.json('id');
    sleep(0.5);

    // Arrasta entre colunas algumas vezes, consultando o quadro no meio
    for (let i = 1; i <= 3; i++) {
        res = http.put(`${BASE_URL}/tasks/${id}/move`, JSON.stringify({ newColumn: COLUMNS[i % 3] }), params('move'));
        check(res, { 'move 200': (r) => r.status === 200 });
        res = http.get(`${BASE_URL}/tasks`, params('list'));
        check(res, { 'list 200': (r) => r.status === 200 });
        sleep(0.5);
    }

    // Edita
    res = http.put(`${BASE_URL}/tasks/${id}`, JSON.stringify({ title: `Editada ${id}`, priority: 'alta' }), params('update'));
    check(res, { 'update 200': (r) => r.status === 200 });

    // Remove
    res = http.del(`${BASE_URL}/tasks/${id}`, null, params('delete'));
    check(res, { 'delete 200': (r) => r.status === 200 });
    sleep(1);
}

// Salva o resumo completo em JSON (base do relatório) além do resumo no terminal
export function handleSummary(data) {
    return {
        '/results/summary.json': JSON.stringify(data, null, 2),
        stdout: textSummary(data)
    };
}

function textSummary(data) {
    const m = data.metrics;
    const fmt = (v) => (v === undefined ? '-' : v.toFixed(1));
    const lines = [
        '',
        `Requisições: ${m.http_reqs.values.count} (${fmt(m.http_reqs.values.rate)} req/s)`,
        `Erros: ${(m.http_req_failed.values.rate * 100).toFixed(2)}%`,
        `Latência geral: média ${fmt(m.http_req_duration.values.avg)}ms | p95 ${fmt(m.http_req_duration.values['p(95)'])}ms | p99 ${fmt(m.http_req_duration.values['p(99)'])}ms`,
        ''
    ];
    for (const ep of ['list', 'create', 'move', 'update', 'delete']) {
        const t = m[`http_req_duration{endpoint:${ep}}`];
        if (t) lines.push(`  ${ep.padEnd(7)} p95 ${fmt(t.values['p(95)'])}ms`);
    }
    for (const [name, th] of Object.entries(data.metrics).filter(([, v]) => v.thresholds)) {
        for (const [expr, r] of Object.entries(th.thresholds)) {
            lines.push(`Threshold ${name} ${expr}: ${r.ok ? 'OK' : 'FALHOU'}`);
        }
    }
    return lines.join('\n') + '\n';
}

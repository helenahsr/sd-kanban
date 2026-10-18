const http = require('http');
const amqp = require('amqplib');
const db = require('./db');
const log = require('./logger');
const { retry, sleep } = require('./retry');

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';
const HEALTH_PORT = 8080;
// Simula um processamento demorado (útil para ver a fila acumular na demo de falha)
const PROCESSING_DELAY_MS = Number(process.env.PROCESSING_DELAY_MS || 0);
// Erros não transitórios (dado inválido, erro de SQL) vão para a DLQ após estas tentativas
const MAX_ATTEMPTS = 3;

// Topologia: deve ser IDÊNTICA à declarada na API (ver api-gateway/src/messaging.js)
const EXCHANGE = 'kanban.events';
const QUEUE = 'task_updates';
const DLQ = 'task_updates.dlq';
const QUEUE_ARGS = { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': DLQ };

let connection = null;
let channel = null;
let shuttingDown = false;

// ==========================================
// PROCESSAMENTO
// ==========================================
function validate(event) {
    if (typeof event.eventId !== 'string' || !event.eventId) throw new Error('Evento sem eventId');
    if (typeof event.event !== 'string' || !event.event) throw new Error('Evento sem tipo');
    if (!Number.isInteger(event.taskId)) throw new Error('Evento sem taskId válido');
}

async function handleMessage(ch, message) {
    let event;
    try {
        event = JSON.parse(message.content.toString());
        validate(event);
    } catch (err) {
        // Mensagem malformada nunca vai dar certo: vai direto para a DLQ
        log.error('Mensagem inválida enviada para a DLQ', { err, messageId: message.properties.messageId });
        ch.nack(message, false, false);
        return;
    }

    const ctx = { correlationId: event.correlationId, eventId: event.eventId, event: event.event, taskId: event.taskId };

    try {
        if (PROCESSING_DELAY_MS) await sleep(PROCESSING_DELAY_MS);

        // Falha transitória (banco fora do ar): tenta indefinidamente com backoff,
        // segurando a mensagem. Com prefetch 1 o resto espera na fila, sem perda.
        // Falha permanente: MAX_ATTEMPTS tentativas e depois DLQ.
        let permanentFailures = 0;
        const saved = await retry(() => db.saveEvent(event, log.INSTANCE), {
            retries: Infinity,
            baseMs: 500,
            maxMs: 15000,
            shouldRetry: (err) => {
                if (shuttingDown || ch !== channel) return false;
                if (db.isTransient(err)) return true;
                return ++permanentFailures < MAX_ATTEMPTS;
            },
            onRetry: (err, attempt, delay) => log.warn('Falha ao processar evento, nova tentativa', { ...ctx, attempt, delayMs: delay, err })
        });

        if (saved) log.info('Evento processado', { ...ctx, details: event.details });
        else log.info('Evento duplicado ignorado (idempotência)', ctx);
        ch.ack(message);
    } catch (err) {
        if (ch !== channel) {
            // O canal caiu durante o processamento: o RabbitMQ reentrega a mensagem sozinho
            log.warn('Canal fechado durante o processamento; mensagem será reentregue', { ...ctx, err });
            return;
        }
        log.error('Evento enviado para a DLQ após falhas', { ...ctx, err });
        ch.nack(message, false, false);
    }
}

// ==========================================
// RABBITMQ (consumer)
// ==========================================
async function connect() {
    await retry(async () => {
        const conn = await amqp.connect(RABBITMQ_URL, { timeout: 5000 });
        try {
            const ch = await conn.createChannel();
            await ch.assertExchange(EXCHANGE, 'fanout', { durable: true });
            await ch.assertQueue(DLQ, { durable: true });
            await ch.assertQueue(QUEUE, { durable: true, arguments: QUEUE_ARGS });
            await ch.bindQueue(QUEUE, EXCHANGE, '');
            // Uma mensagem por vez por réplica: as réplicas dividem a fila (consumidores concorrentes)
            await ch.prefetch(1);
            connection = conn;
            channel = ch;
            await ch.consume(QUEUE, (message) => {
                if (message) handleMessage(ch, message);
            });
        } catch (err) {
            conn.close().catch(() => {});
            throw err;
        }
    }, {
        retries: Infinity,
        baseMs: 1000,
        maxMs: 15000,
        onRetry: (err, attempt, delay) => log.warn('RabbitMQ indisponível, nova tentativa', { attempt, delayMs: delay, err })
    });

    log.info('Worker conectado e consumindo a fila', { queue: QUEUE, dlq: DLQ });

    connection.on('error', (err) => log.error('Erro na conexão com o RabbitMQ', { err }));
    connection.on('close', () => {
        connection = null;
        channel = null;
        if (shuttingDown) return;
        log.error('Conexão com o RabbitMQ perdida, reconectando');
        connect();
    });
}

// ==========================================
// HEALTH CHECK
// ==========================================
http.createServer(async (req, res) => {
    if (req.url !== '/health') {
        res.writeHead(404).end();
        return;
    }
    let database = true;
    try { await db.ping(); } catch { database = false; }
    const rabbitmq = channel !== null;
    const ok = database && rabbitmq;
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: ok ? 'ok' : 'down', service: 'worker', instance: log.INSTANCE, database, rabbitmq }));
}).listen(HEALTH_PORT, () => log.info('Health check disponível', { port: HEALTH_PORT }));

// ==========================================
// INICIALIZAÇÃO E ENCERRAMENTO
// ==========================================
(async () => {
    await db.ensureSchema();
    await connect();
})();

// No `docker stop`, fecha a conexão: mensagens não confirmadas voltam para a fila
async function shutdown(signal) {
    log.info('Encerrando', { signal });
    shuttingDown = true;
    setTimeout(() => process.exit(0), 5000).unref();
    if (connection) await connection.close().catch(() => {});
    process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const amqp = require('amqplib');
const log = require('./logger');
const { retry, withTimeout } = require('./retry');

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';

// Topologia (deve ser IDÊNTICA à declarada no worker):
//   kanban.events (fanout) ──► task_updates      → worker (consumidores concorrentes)
//                         └──► fila exclusiva    → cada réplica da API (repasse ao Socket.io)
//   task_updates rejeitada ──► task_updates.dlq  (dead letter queue)
const EXCHANGE = 'kanban.events';
const QUEUE = 'task_updates';
const DLQ = 'task_updates.dlq';
const QUEUE_ARGS = { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': DLQ };

const PUBLISH_TIMEOUT_MS = 5000;

let connection = null;
let channel = null;
let shuttingDown = false;

async function setupTopology(ch) {
    await ch.assertExchange(EXCHANGE, 'fanout', { durable: true });
    await ch.assertQueue(DLQ, { durable: true });
    // A API também declara a fila do worker: assim eventos publicados enquanto
    // o worker está fora do ar ficam guardados em vez de serem descartados
    await ch.assertQueue(QUEUE, { durable: true, arguments: QUEUE_ARGS });
    await ch.bindQueue(QUEUE, EXCHANGE, '');
}

// Conecta com retry e backoff exponencial (sem limite de tentativas).
// `onEvent` recebe cada evento do fanout para ser repassado aos clientes desta réplica.
async function connect(onEvent) {
    await retry(async () => {
        const conn = await amqp.connect(RABBITMQ_URL, { timeout: 5000 });
        try {
            // Confirm channel: o broker confirma que recebeu cada mensagem
            const ch = await conn.createConfirmChannel();
            await setupTopology(ch);

            // Fila exclusiva desta réplica (apagada quando ela desconecta)
            const { queue } = await ch.assertQueue('', { exclusive: true, autoDelete: true });
            await ch.bindQueue(queue, EXCHANGE, '');
            await ch.consume(queue, (msg) => {
                if (!msg) return;
                try {
                    onEvent(JSON.parse(msg.content.toString()));
                } catch (err) {
                    log.error('Evento inválido recebido no fanout', { err });
                }
            }, { noAck: true });

            connection = conn;
            channel = ch;
        } catch (err) {
            conn.close().catch(() => {});
            throw err;
        }
    }, {
        retries: Infinity,
        baseMs: 1000,
        maxMs: 15000,
        onRetry: (err, attempt, delay) =>
            log.warn('RabbitMQ indisponível, nova tentativa', { attempt, delayMs: delay, err })
    });

    log.info('Conectado ao RabbitMQ', { exchange: EXCHANGE, queue: QUEUE });

    connection.on('error', (err) => log.error('Erro na conexão com o RabbitMQ', { err }));
    connection.on('close', () => {
        connection = null;
        channel = null;
        if (shuttingDown) return;
        log.error('Conexão com o RabbitMQ perdida, reconectando');
        connect(onEvent);
    });
}

// Publica com confirmação do broker, timeout e retry. Uma nova tentativa pode gerar
// mensagem duplicada; por isso o worker é idempotente (deduplica pelo eventId).
async function publish(event) {
    return retry(() => {
        const ch = channel;
        if (!ch) throw new Error('RabbitMQ indisponível');
        const confirmed = new Promise((resolve, reject) => {
            ch.publish(EXCHANGE, '', Buffer.from(JSON.stringify(event)), {
                persistent: true,
                contentType: 'application/json',
                messageId: event.eventId,
                correlationId: event.correlationId,
                type: event.event
            }, (err) => (err ? reject(err) : resolve()));
        });
        return withTimeout(confirmed, PUBLISH_TIMEOUT_MS, 'confirmação do RabbitMQ');
    }, {
        retries: 2,
        baseMs: 200,
        onRetry: (err, attempt, delay) =>
            log.warn('Falha ao publicar evento, nova tentativa', {
                correlationId: event.correlationId, eventId: event.eventId, attempt, delayMs: delay, err
            })
    });
}

const isConnected = () => channel !== null;

async function close() {
    shuttingDown = true;
    if (connection) await connection.close().catch(() => {});
}

module.exports = { connect, publish, isConnected, close };

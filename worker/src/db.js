const mysql = require('mysql2/promise');
const log = require('./logger');
const { retry } = require('./retry');

// Banco PRÓPRIO do worker (serviço history-db). A API não acessa este banco:
// o histórico só chega aqui pelos eventos da fila.
const pool = mysql.createPool({
    uri: process.env.DB_URL || 'mysql://root@localhost:3306/historico',
    waitForConnections: true,
    connectionLimit: 5,
    connectTimeout: 5000,
    charset: 'utf8mb4'
});

const QUERY_TIMEOUT_MS = 5000;

// event_id como chave primária garante a idempotência: reprocessar o mesmo
// evento (reentrega do RabbitMQ, retry do publisher) não cria linha duplicada
const SCHEMA = `
    CREATE TABLE IF NOT EXISTS historico (
        event_id CHAR(36) PRIMARY KEY,
        correlation_id VARCHAR(64),
        task_id INT NOT NULL,
        evento VARCHAR(30) NOT NULL,
        detalhes JSON,
        ocorrido_em DATETIME(3) NOT NULL,
        processado_em DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        processado_por VARCHAR(64),
        INDEX idx_historico_task (task_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const CONNECT_ERRORS = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST', 'ECONNRESET'];
const isTransient = (err) => CONNECT_ERRORS.includes(err.code) || /timeout/i.test(err.message);

// O serviço é dono do próprio schema: cria a tabela ao subir (com retry até o banco responder)
async function ensureSchema() {
    await retry(() => pool.query({ sql: SCHEMA, timeout: QUERY_TIMEOUT_MS }), {
        retries: Infinity,
        baseMs: 1000,
        maxMs: 15000,
        onRetry: (err, attempt, delay) => log.warn('Banco de histórico indisponível, nova tentativa', { attempt, delayMs: delay, err })
    });
    log.info('Schema do histórico pronto');
}

// Retorna true se gravou, false se o evento já tinha sido processado (duplicado)
async function saveEvent(event, instance) {
    try {
        await pool.query({
            sql: `INSERT INTO historico
                    (event_id, correlation_id, task_id, evento, detalhes, ocorrido_em, processado_por)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            timeout: QUERY_TIMEOUT_MS
        }, [
            event.eventId,
            event.correlationId || null,
            event.taskId,
            event.event,
            JSON.stringify(event.details || {}),
            new Date(event.at || Date.now()),
            instance
        ]);
        return true;
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return false;
        throw err;
    }
}

async function ping() {
    await pool.query({ sql: 'SELECT 1', timeout: 2000 });
}

module.exports = { ensureSchema, saveEvent, ping, isTransient };

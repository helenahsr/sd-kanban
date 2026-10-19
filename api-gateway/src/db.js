const mysql = require('mysql2/promise');
const log = require('./logger');
const { retry } = require('./retry');

const QUERY_TIMEOUT_MS = 5000;

// DB_URL vem do docker-compose: mysql://usuario:senha@database:3306/kanban
const pool = mysql.createPool({
    uri: process.env.DB_URL || 'mysql://root@localhost:3306/kanban',
    waitForConnections: true,
    connectionLimit: 10,
    connectTimeout: 5000,
    charset: 'utf8mb4'
});

// Erros em que a query certamente NÃO foi executada (falha ao abrir a conexão)
const CONNECT_ERRORS = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST'];
const isTransient = (err) => CONNECT_ERRORS.includes(err.code);

// Toda query tem timeout. Operações idempotentes (leitura, UPDATE com valores fixos)
// ganham retry com backoff; INSERT não, para não criar a tarefa duas vezes.
function query(sql, params, { idempotent = true, correlationId } = {}) {
    const run = () => pool.query({ sql, timeout: QUERY_TIMEOUT_MS }, params);
    if (!idempotent) return run();
    return retry(run, {
        retries: 2,
        baseMs: 200,
        shouldRetry: isTransient,
        onRetry: (err, attempt, delay) =>
            log.warn('Falha transitória no MySQL, nova tentativa', { correlationId, attempt, delayMs: delay, err })
    });
}

const VALID_STATUS = ['todo', 'doing', 'done'];
const VALID_PRIORITY = ['alta', 'media', 'baixa'];

// Converte a linha do banco para o formato usado pelo frontend
function toTask(row) {
    return {
        id: row.id,
        title: row.titulo,
        creator: row.relator,
        assignee: row.responsavel,
        priority: row.prioridade,
        status: row.status,
        updatedAt: row.updated_at
    };
}

const SELECT_TASK = `
    SELECT c.id, c.titulo, c.relator, c.responsavel, c.prioridade, c.updated_at, s.codigo AS status
    FROM card c
    JOIN status s ON s.id = c.fk_id_status
    WHERE c.deleted_at IS NULL`;

async function listTasks(ctx) {
    const [rows] = await query(`${SELECT_TASK} ORDER BY c.id`, [], ctx);
    return rows.map(toTask);
}

async function getTask(id, ctx) {
    const [rows] = await query(`${SELECT_TASK} AND c.id = ?`, [id], ctx);
    return rows.length ? toTask(rows[0]) : null;
}

async function createTask({ title, creator, assignee, priority, status }, ctx = {}) {
    const [result] = await query(
        `INSERT INTO card (titulo, relator, responsavel, prioridade, fk_id_status)
         SELECT ?, ?, ?, ?, id FROM status WHERE codigo = ?`,
        [title, creator, assignee, priority, status],
        { ...ctx, idempotent: false }
    );
    return getTask(result.insertId, ctx);
}

// Atualiza só os campos enviados; devolve a tarefa atualizada ou null se não existir
async function updateTask(id, { title, assignee, priority, status }, ctx) {
    const sets = [];
    const params = [];
    if (title !== undefined) { sets.push('c.titulo = ?'); params.push(title); }
    if (assignee !== undefined) { sets.push('c.responsavel = ?'); params.push(assignee); }
    if (priority !== undefined) { sets.push('c.prioridade = ?'); params.push(priority); }
    if (status !== undefined) {
        sets.push('c.fk_id_status = (SELECT id FROM status WHERE codigo = ?)');
        params.push(status);
    }
    if (sets.length) {
        await query(
            `UPDATE card c SET ${sets.join(', ')} WHERE c.id = ? AND c.deleted_at IS NULL`,
            [...params, id],
            ctx
        );
    }
    return getTask(id, ctx);
}

async function deleteTask(id, ctx) {
    const [result] = await query(
        'UPDATE card SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL',
        [id],
        ctx
    );
    return result.affectedRows > 0;
}

async function ping() {
    await pool.query({ sql: 'SELECT 1', timeout: 2000 });
}

module.exports = {
    VALID_STATUS,
    VALID_PRIORITY,
    listTasks,
    getTask,
    createTask,
    updateTask,
    deleteTask,
    ping
};

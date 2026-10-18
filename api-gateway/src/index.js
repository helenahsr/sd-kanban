const express = require('express');
const http = require('http');
const { randomUUID } = require('crypto');
const { Server } = require('socket.io');
const db = require('./db');
const messaging = require('./messaging');
const log = require('./logger');

const PORT = 4000;

const app = express();
// Cria o servidor HTTP explicitamente para o Socket.io conseguir se acoplar
const server = http.createServer(app);

// CORS do WebSocket. O cliente usa só transporte websocket, então não precisa de
// sticky session no balanceador (o long-polling exigiria cair sempre na mesma réplica)
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST", "PUT", "DELETE"]
    }
});

// CORS para as rotas REST (o cors do Socket.io acima só vale para o WebSocket)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Correlation-Id');
    res.header('Access-Control-Expose-Headers', 'X-Correlation-Id, X-Instance');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// Correlation id: vem do frontend/balanceador ou é gerado aqui. Segue para o
// RabbitMQ, o worker e o evento do Socket.io, ligando os logs de todos os serviços.
app.use((req, res, next) => {
    req.correlationId = req.get('X-Correlation-Id') || randomUUID();
    res.set('X-Correlation-Id', req.correlationId);
    res.set('X-Instance', log.INSTANCE);

    const start = process.hrtime.bigint();
    res.on('finish', () => {
        if (req.path === '/health') return; // healthcheck do Docker roda a cada poucos segundos
        log.info('request', {
            correlationId: req.correlationId,
            method: req.method,
            path: req.originalUrl,
            status: res.statusCode,
            durationMs: Number(process.hrtime.bigint() - start) / 1e6
        });
    });
    next();
});

app.use(express.json());

// ==========================================
// EVENTOS (RabbitMQ + Socket.io)
// ==========================================
io.on('connection', (socket) => {
    log.info('Cliente conectado via WebSocket', { socketId: socket.id });
    socket.on('disconnect', () => log.info('Cliente desconectado', { socketId: socket.id }));
});

// Cada réplica recebe TODOS os eventos pelo fanout e repassa aos seus próprios clientes.
// Assim um card movido via réplica A aparece também para quem está conectado na réplica B.
function relayToClients(event) {
    io.emit(event.event, event);
    log.info('Evento repassado aos clientes WebSocket', {
        correlationId: event.correlationId, eventId: event.eventId, event: event.event, clients: io.engine.clientsCount
    });
}

// Publica o evento no broker. Se o broker estiver fora do ar, a operação no banco
// já foi feita: avisa só os clientes desta réplica (degradação controlada) e segue.
async function dispatch(req, event, taskId, { task = null, details = {} } = {}) {
    const payload = {
        eventId: randomUUID(),
        event,
        correlationId: req.correlationId,
        taskId,
        task,
        details,
        at: new Date().toISOString(),
        origin: log.INSTANCE
    };
    try {
        await messaging.publish(payload);
        return true;
    } catch (err) {
        log.error('Evento não publicado no RabbitMQ; entregando só aos clientes desta réplica', {
            correlationId: req.correlationId, eventId: payload.eventId, event, err
        });
        io.emit(event, payload);
        return false;
    }
}

// ==========================================
// VALIDAÇÃO
// ==========================================
function cleanText(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Valida o corpo da requisição. Em `partial` (edição), campos ausentes são ignorados.
function parseTaskBody(body, { partial = false } = {}) {
    const data = {};
    const errors = [];
    body = body || {};

    for (const [field, max] of [['title', 255], ['assignee', 100], ['creator', 100]]) {
        if (body[field] === undefined && partial) continue;
        if (field === 'creator' && partial) continue; // criador não muda na edição
        const value = cleanText(body[field], max);
        if (!value) errors.push(`Campo ${field} é obrigatório`);
        data[field] = value;
    }

    if (body.priority !== undefined || !partial) {
        data.priority = body.priority || 'media';
        if (!db.VALID_PRIORITY.includes(data.priority)) errors.push('Prioridade inválida');
    }

    if (body.status !== undefined || !partial) {
        data.status = body.status || 'todo';
        if (!db.VALID_STATUS.includes(data.status)) errors.push('Status inválido');
    }

    return { data, errors };
}

function parseId(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ success: false, message: 'ID inválido' });
        return null;
    }
    return id;
}

// ==========================================
// ROTAS
// ==========================================

// 200 = pronto (RabbitMQ fora do ar = "degraded", ainda atende); 503 = sem banco, tirar do balanceamento
app.get('/health', async (req, res) => {
    let database = true;
    try { await db.ping(); } catch { database = false; }
    const rabbitmq = messaging.isConnected();
    const status = !database ? 'down' : rabbitmq ? 'ok' : 'degraded';
    res.status(database ? 200 : 503).json({ status, service: 'api-gateway', instance: log.INSTANCE, database, rabbitmq });
});

app.get('/tasks', async (req, res) => {
    res.json(await db.listTasks(req));
});

app.post('/tasks', async (req, res) => {
    const { data, errors } = parseTaskBody(req.body);
    if (errors.length) return res.status(400).json({ success: false, message: errors.join('; ') });

    const task = await db.createTask(data, req);
    await dispatch(req, 'task_created', task.id, { task, details: { status: task.status } });

    res.status(201).json(task);
});

// Edição completa (título, responsável, prioridade e, opcionalmente, coluna)
app.put('/tasks/:id', async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;

    const { data, errors } = parseTaskBody(req.body, { partial: true });
    if (errors.length) return res.status(400).json({ success: false, message: errors.join('; ') });

    const before = await db.getTask(id, req);
    if (!before) return res.status(404).json({ success: false, message: 'Tarefa não encontrada' });

    const task = await db.updateTask(id, data, req);
    await dispatch(req, 'task_updated', id, { task, details: { from: before, to: task } });

    res.json(task);
});

// Movimentação entre colunas (drag and drop)
app.put('/tasks/:id/move', async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;

    const { newColumn } = req.body || {};
    if (!db.VALID_STATUS.includes(newColumn)) {
        return res.status(400).json({ success: false, message: 'Campo newColumn inválido' });
    }

    const before = await db.getTask(id, req);
    if (!before) return res.status(404).json({ success: false, message: 'Tarefa não encontrada' });

    const task = await db.updateTask(id, { status: newColumn }, req);
    const queued = await dispatch(req, 'task_moved', id, { task, details: { from: before.status, to: newColumn } });

    res.json({ success: true, queued, task });
});

app.delete('/tasks/:id', async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;

    const deleted = await db.deleteTask(id, req);
    if (!deleted) return res.status(404).json({ success: false, message: 'Tarefa não encontrada' });

    await dispatch(req, 'task_deleted', id);

    res.json({ success: true });
});

// Express 5 encaminha erros de rotas async para cá
app.use((err, req, res, next) => {
    log.error('Erro na requisição', { correlationId: req.correlationId, method: req.method, path: req.originalUrl, err });
    res.status(500).json({ success: false, message: 'Erro interno no servidor' });
});

// IMPORTANTE: Use server.listen em vez de app.listen para subir tanto a API quanto os WebSockets
server.listen(PORT, () => log.info('API e WebSockets rodando', { port: PORT }));
messaging.connect(relayToClients);

// Encerramento limpo no `docker stop`: termina as requisições em andamento e fecha conexões
function shutdown(signal) {
    log.info('Encerrando', { signal });
    setTimeout(() => process.exit(0), 5000).unref();
    io.close();
    server.close(async () => {
        await messaging.close();
        process.exit(0);
    });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

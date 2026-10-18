const os = require('os');

const SERVICE = 'api-gateway';
// Em réplicas do Docker, o hostname é o ID do contêiner: identifica qual réplica atendeu
const INSTANCE = os.hostname();

// Log estruturado: uma linha JSON por evento, sempre com serviço e instância.
// Passe `correlationId` nos campos para rastrear a requisição entre os serviços.
function write(level, msg, fields = {}) {
    const line = { ts: new Date().toISOString(), level, service: SERVICE, instance: INSTANCE, msg, ...fields };
    if (fields.err instanceof Error) line.err = fields.err.message;
    const out = level === 'error' ? process.stderr : process.stdout;
    out.write(JSON.stringify(line) + '\n');
}

module.exports = {
    INSTANCE,
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields)
};

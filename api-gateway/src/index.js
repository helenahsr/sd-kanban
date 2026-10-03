const express = require('express');
const { connectRabbitMQ, sendToQueue } = require('./rabbitmq');

const app = express();
app.use(express.json());

// Inicia a conexão com o RabbitMQ
connectRabbitMQ();

// Rota simulando a movimentação de um card no Kanban
app.post('/move-task', (req, res) => {
    const { taskId, newColumn } = req.body;
    
    // Futuramente: lógica para atualizar o card no MySQL entrará aqui

    // Envia a mensagem para a fila processar de forma assíncrona
    sendToQueue('task_updates', { taskId, newColumn, timestamp: Date.now() });

    res.json({ success: true, message: 'Tarefa movida e evento enfileirado!' });
});

app.listen(4000, () => console.log('API rodando na porta 4000'));
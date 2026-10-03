const amqp = require('amqplib');

let channel = null;

async function connectRabbitMQ() {
    try {
        // Usa a variável de ambiente definida no docker-compose
        const connection = await amqp.connect(process.env.RABBITMQ_URL);
        channel = await connection.createChannel();
        
        // Garante que a fila existe antes de enviar mensagens
        await channel.assertQueue('task_updates');
        console.log('Conectado ao RabbitMQ com sucesso!');
    } catch (error) {
        console.error('Erro ao conectar no RabbitMQ:', error);
    }
}

function sendToQueue(queue, message) {
    if (channel) {
        channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)));
    }
}

module.exports = { connectRabbitMQ, sendToQueue };
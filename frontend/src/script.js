const cards = document.querySelectorAll('.card');
const columns = document.querySelectorAll('.column');

let draggedCard = null;

// Eventos para iniciar e terminar o arrasto do cartão
cards.forEach(card => {
    card.addEventListener('dragstart', () => {
        draggedCard = card;
        setTimeout(() => card.style.display = 'none', 0);
    });

    card.addEventListener('dragend', () => {
        setTimeout(() => {
            draggedCard.style.display = 'block';
            draggedCard = null;
        }, 0);
    });
});

// Eventos para as colunas receberem os cartões
columns.forEach(column => {
    column.addEventListener('dragover', e => {
        e.preventDefault();
        column.classList.add('drag-over');
    });

    column.addEventListener('dragleave', () => {
        column.classList.remove('drag-over');
    });

    column.addEventListener('drop', e => {
        e.preventDefault();
        column.classList.remove('drag-over');
        
        if (draggedCard) {
            column.appendChild(draggedCard);
            const newStatus = column.getAttribute('data-status');
            const taskId = draggedCard.id;
            
            console.log(`Enviando para API: Tarefa ${taskId} movida para ${newStatus}`);
            
            // TODO: Descomentar quando a API estiver pronta para gravar no MySQL
            /* 
            fetch('http://localhost:4000/move-task', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId, newColumn: newStatus })
            });
            */
        }
    });
});

// TODO: Descomentar quando o WebSocket for configurado no API Gateway
/*
const socket = io('http://localhost:4000');
socket.on('task_moved', (data) => {
    console.log('Atualização recebida via WebSocket:', data);
    const card = document.getElementById(data.taskId);
    const targetColumn = document.getElementById(data.newColumn);
    
    // Move o cartão visualmente se a requisição veio de outra máquina
    if (card && targetColumn) {
        targetColumn.appendChild(card);
    }
});
*/
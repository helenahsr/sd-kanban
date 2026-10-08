const columns = document.querySelectorAll('.column');

// Elementos do Modal
const addBtn = document.getElementById('addBtn');
const taskModal = document.getElementById('taskModal');
const closeModalBtn = document.getElementById('closeModalBtn');
const taskForm = document.getElementById('taskForm');
const modalTitle = document.getElementById('modalTitle');
const taskCreatorInput = document.getElementById('taskCreator');

let draggedCard = null;
let editingCard = null; // Guarda o cartão que está sendo editado no momento (null = criando novo)

// ==========================================
// EVENTOS DE CARTÃO (ARRASTAR, EDITAR, EXCLUIR)
// ==========================================
function setupCardEvents(card) {
    // 1. Eventos de Arrastar
    card.addEventListener('dragstart', () => {
        draggedCard = card;
        setTimeout(() => card.style.display = 'none', 0);
    });

    card.addEventListener('dragend', () => {
        setTimeout(() => {
            draggedCard.style.display = 'flex';
            draggedCard = null;
        }, 0);
    });

    // 2. Evento do Botão Editar
    const editBtn = card.querySelector('.edit-btn');
    editBtn.addEventListener('click', () => {
        openEditModal(card);
    });

    // 3. Evento do Botão Excluir (Bônus)
    const deleteBtn = card.querySelector('.delete-btn');
    deleteBtn.addEventListener('click', () => {
        if(confirm('Tem certeza que deseja excluir esta tarefa?')) {
            card.remove();
        }
    });
}

// Aplica os eventos nos cartões que já vêm no HTML
document.querySelectorAll('.card').forEach(card => {
    setupCardEvents(card);
});

// ==========================================
// DRAG AND DROP NAS COLUNAS
// ==========================================
columns.forEach(column => {
    column.addEventListener('dragover', e => {
        e.preventDefault();
        column.classList.replace('bg-gray-200', 'bg-gray-300');
    });

    column.addEventListener('dragleave', () => {
        column.classList.replace('bg-gray-300', 'bg-gray-200');
    });

    column.addEventListener('drop', e => {
        e.preventDefault();
        column.classList.replace('bg-gray-300', 'bg-gray-200');
        
        if (draggedCard) {
            column.appendChild(draggedCard);
            const newStatus = column.getAttribute('data-status');
            console.log(`Enviando para API: Tarefa ${draggedCard.id} movida para ${newStatus}`);
        }
    });
});

// ==========================================
// LÓGICA DO MODAL (CRIAR E EDITAR)
// ==========================================

// Abrir Modal para CRIAR Nova Tarefa
addBtn.addEventListener('click', () => {
    editingCard = null; // Define que estamos criando e não editando
    modalTitle.textContent = 'Nova Tarefa';
    
    taskCreatorInput.disabled = false; // Desbloqueia campo criador
    
    taskForm.reset(); // Limpa form
    taskModal.classList.remove('hidden');
    taskModal.classList.add('flex');
});

// Abrir Modal para EDITAR Tarefa Existente
function openEditModal(card) {
    editingCard = card; // Salva a referência de qual cartão estamos editando
    modalTitle.textContent = 'Editar Tarefa';

    // Preenche o modal com os dados do cartão (lidos do data-attributes)
    document.getElementById('taskName').value = card.dataset.name;
    document.getElementById('taskAssignee').value = card.dataset.assignee;
    
    taskCreatorInput.value = card.dataset.creator;
    taskCreatorInput.disabled = true; // Bloqueia o campo criador para edição

    // Descobre em qual coluna o cartão está atualmente e seleciona no Select
    const currentStatus = card.closest('.column').getAttribute('data-status');
    document.getElementById('taskStatus').value = currentStatus;

    // Exibe o modal
    taskModal.classList.remove('hidden');
    taskModal.classList.add('flex');
}

// Fechar Modal (botão cancelar)
closeModalBtn.addEventListener('click', () => {
    taskModal.classList.add('hidden');
    taskModal.classList.remove('flex');
    taskForm.reset(); 
});

// Enviar Formulário (Serve tanto para Criar quanto para Salvar Edição)
taskForm.addEventListener('submit', (e) => {
    e.preventDefault(); 

    const taskName = document.getElementById('taskName').value;
    const taskStatus = document.getElementById('taskStatus').value;
    const taskAssignee = document.getElementById('taskAssignee').value;
    const taskCreator = document.getElementById('taskCreator').value;

    const targetColumn = document.getElementById(taskStatus);

    if (editingCard) {
        // === FLUXO DE EDIÇÃO ===
        
        // 1. Atualiza os dados no HTML interno
        editingCard.dataset.name = taskName;
        editingCard.dataset.assignee = taskAssignee;
        // obs: não atualizamos dataset.creator pois é bloqueado
        
        // 2. Atualiza o texto visual
        editingCard.querySelector('.task-name').textContent = taskName;
        editingCard.querySelector('.task-details').textContent = `Resp: ${taskAssignee} | Criador: ${editingCard.dataset.creator}`;

        // 3. Verifica se a coluna/status foi alterada e move se necessário
        const currentColumnId = editingCard.closest('.column').getAttribute('data-status');
        if (currentColumnId !== taskStatus) {
            targetColumn.appendChild(editingCard);
            console.log(`Tarefa ${editingCard.id} editada e movida para ${taskStatus}`);
        } else {
            console.log(`Tarefa ${editingCard.id} editada no mesmo status`);
        }

    } else {
        // === FLUXO DE CRIAÇÃO ===
        
        const newTaskId = `task-${Date.now()}`;
        const newCard = document.createElement('div');
        newCard.className = 'card bg-white p-4 mb-3 rounded shadow-sm cursor-grab active:cursor-grabbing flex justify-between items-center group hover:shadow-md transition-shadow shrink-0';
        newCard.draggable = true;
        newCard.id = newTaskId;

        // Salva os dados como atributos
        newCard.dataset.name = taskName;
        newCard.dataset.assignee = taskAssignee;
        newCard.dataset.creator = taskCreator;

        newCard.innerHTML = `
            <div class="flex flex-col pr-2 overflow-hidden w-full">
                <span class="task-name text-gray-800 font-medium truncate">${taskName}</span>
                <span class="task-details text-xs text-gray-500 mt-1 truncate">Resp: ${taskAssignee} | Criador: ${taskCreator}</span>
            </div>
            <div class="flex gap-2 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                <button class="edit-btn text-sm text-blue-500 hover:text-blue-700 font-medium px-2 py-1 bg-blue-50 rounded hover:bg-blue-100 transition">Editar</button>
                <button class="delete-btn text-sm text-red-500 hover:text-red-700 font-bold px-2 py-1 bg-red-50 rounded hover:bg-red-100 transition">X</button>
            </div>
        `;

        setupCardEvents(newCard); // Associa todos os eventos de clique e arrasto
        targetColumn.appendChild(newCard); // Adiciona na tela
        
        console.log(`Nova tarefa criada: ${newTaskId} na coluna ${taskStatus}`);
    }

    // Fecha o modal limpando o form
    taskModal.classList.add('hidden');
    taskModal.classList.remove('flex');
    taskForm.reset();
});

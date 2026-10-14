// ==========================================
// SELEÇÃO DE ELEMENTOS DO DOM
// ==========================================
const columns = document.querySelectorAll('.column');

// Elementos do Modal
const addBtn = document.getElementById('addBtn');
const headerAddBtn = document.getElementById('headerAddBtn');
const taskModal = document.getElementById('taskModal');
const closeModalBtn = document.getElementById('closeModalBtn');
const closeModalXBtn = document.getElementById('closeModalXBtn');
const taskForm = document.getElementById('taskForm');
const modalTitle = document.getElementById('modalTitle');
const taskNameInput = document.getElementById('taskName');
const taskStatusInput = document.getElementById('taskStatus');
const taskPriorityInput = document.getElementById('taskPriority');
const taskAssigneeInput = document.getElementById('taskAssignee');
const taskCreatorInput = document.getElementById('taskCreator');
const searchInput = document.getElementById('searchInput');

// Variáveis de Controle de Estado
let draggedCard = null;
let editingCard = null; // null = criando novo, objeto = editando

// Elemento Placeholder Visual para Drag & Drop
const placeholder = document.createElement('div');
placeholder.className = 'drop-placeholder w-full rounded-xl border-2 border-dashed border-indigo-400 bg-indigo-50/60 my-2 transition-all duration-150 pointer-events-none flex items-center justify-center text-xs font-semibold text-indigo-600 select-none';
placeholder.innerHTML = '<span>Soltar aqui</span>';

// ==========================================
// FUNÇÕES AUXILIARES DE DESIGN E BADGES
// ==========================================

// Retorna o HTML do badge de prioridade com cores distintas
function getPriorityBadgeHTML(priority) {
    const p = (priority || 'media').toLowerCase();
    if (p === 'alta') {
        return `<span class="priority-badge text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-rose-50 text-rose-600 border border-rose-200/60">Alta</span>`;
    } else if (p === 'baixa') {
        return `<span class="priority-badge text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200/60">Baixa</span>`;
    } else {
        return `<span class="priority-badge text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 border border-amber-200/60">Média</span>`;
    }
}

// Retorna cores harmoniosas para o avatar com base no nome
function getAvatarClasses(name) {
    const palette = [
        'bg-indigo-100 text-indigo-700',
        'bg-amber-100 text-amber-700',
        'bg-violet-100 text-violet-700',
        'bg-emerald-100 text-emerald-700',
        'bg-sky-100 text-sky-700',
        'bg-rose-100 text-rose-700'
    ];
    let hash = 0;
    for (let i = 0; i < (name || '').length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return palette[Math.abs(hash) % palette.length];
}

// Atualiza contadores de cada coluna e resumo geral
function updateCounters() {
    let total = 0;
    columns.forEach(col => {
        const status = col.getAttribute('data-status');
        const countBadge = document.getElementById(`${status}Count`);
        const cardsContainer = col.querySelector('.cards-container');
        const cards = cardsContainer ? cardsContainer.querySelectorAll('.card') : [];
        const emptyState = col.querySelector('.column-empty-state');

        if (countBadge) {
            countBadge.textContent = cards.length;
        }

        if (emptyState) {
            if (cards.length === 0) {
                emptyState.classList.remove('hidden');
                emptyState.classList.add('flex');
            } else {
                emptyState.classList.add('hidden');
                emptyState.classList.remove('flex');
            }
        }

        total += cards.length;
    });

    const totalCountEl = document.getElementById('totalTasksCount');
    if (totalCountEl) {
        totalCountEl.textContent = total;
    }
}

// Notifica a API Gateway de forma assíncrona
async function notifyBackendMove(taskId, newColumn) {
    console.log(`[API Sync] Tarefa ${taskId} movida para ${newColumn}`);
    try {
        await fetch('http://localhost:4000/move-task', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId, newColumn })
        });
    } catch (err) {
        // Log leve caso backend esteja desligado no teste frontend
        console.warn('[API Gateway] Não foi possível contatar o servidor local:', err.message);
    }
}

// ==========================================
// ALGORITMO DE INSERÇÃO EXATA (DRAG & DROP)
// ==========================================

/**
 * Calcula qual elemento card deve vir DEPOIS da posição atual do cursor.
 * Se o cursor estiver antes da metade de um card, aquele card virá DEPOIS (inserção no meio ou início).
 * Se o cursor estiver após todos os cards, retorna null (inserção no final).
 */
function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.card:not(.dragging)')];

    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        // Distância vertical do cursor até o centro do card
        const offset = y - box.top - box.height / 2;

        // offset < 0 significa que o cursor está acima do centro deste card
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// ==========================================
// EVENTOS DE CARTÃO (ARRASTO, EDIÇÃO, EXCLUSÃO)
// ==========================================
function setupCardEvents(card) {
    // 1. Início do Arraste
    card.addEventListener('dragstart', (e) => {
        draggedCard = card;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', card.id);

        // Ajusta a altura do placeholder visual para coincidir com o card
        const cardHeight = card.offsetHeight || 90;
        placeholder.style.height = `${cardHeight}px`;

        // Timeout 0 permite que o navegador capture a imagem fantasma antes de ocultar o card original
        setTimeout(() => {
            if (draggedCard === card) {
                card.style.display = 'none';
            }
        }, 0);
    });

    // 2. Fim do Arraste (inclusive se cancelado ou solto fora)
    card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        card.style.display = 'flex';

        if (placeholder && placeholder.parentNode) {
            placeholder.remove();
        }

        columns.forEach(col => col.classList.remove('column-drag-active'));
        draggedCard = null;
        updateCounters();
    });

    // 3. Botão Editar
    const editBtn = card.querySelector('.edit-btn');
    if (editBtn) {
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openEditModal(card);
        });
    }

    // 4. Botão Excluir
    const deleteBtn = card.querySelector('.delete-btn');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const taskTitle = card.dataset.name || 'esta tarefa';
            if (confirm(`Tem certeza que deseja excluir "${taskTitle}"?`)) {
                card.remove();
                updateCounters();
            }
        });
    }
}

// ==========================================
// DRAG AND DROP NAS COLUNAS E CONTAINERS
// ==========================================
columns.forEach(column => {
    const cardsContainer = column.querySelector('.cards-container');

    // Ao passar por cima da coluna ou seus cards
    column.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!draggedCard) return;

        column.classList.add('column-drag-active');

        // Calcula a posição precisa onde o card deve entrar
        const afterElement = getDragAfterElement(cardsContainer, e.clientY);

        if (afterElement == null) {
            // Entra no FINAL da coluna
            cardsContainer.appendChild(placeholder);
        } else {
            // Entra ANTES do card detectado (permitindo entrar no INÍCIO ou no MEIO)
            cardsContainer.insertBefore(placeholder, afterElement);
        }
    });

    column.addEventListener('dragleave', (e) => {
        // Só remove highlight quando o cursor sair completamente da coluna
        if (!column.contains(e.relatedTarget)) {
            column.classList.remove('column-drag-active');
        }
    });

    column.addEventListener('drop', (e) => {
        e.preventDefault();
        column.classList.remove('column-drag-active');

        if (draggedCard) {
            // Insere o card exatamente na posição onde o placeholder estava
            if (placeholder && placeholder.parentNode) {
                placeholder.parentNode.insertBefore(draggedCard, placeholder);
                placeholder.remove();
            } else {
                cardsContainer.appendChild(draggedCard);
            }

            // Exibe o card novamente
            draggedCard.style.display = 'flex';
            draggedCard.classList.remove('dragging');

            const newStatus = column.getAttribute('data-status');
            console.log(`Tarefa ${draggedCard.id} posicionada com sucesso na coluna ${newStatus}`);

            // Envia evento para a API e atualiza a interface
            notifyBackendMove(draggedCard.id, newStatus);
            updateCounters();
        }
    });
});

// ==========================================
// LÓGICA DO MODAL (CRIAR E EDITAR)
// ==========================================

// Abre modal para Nova Tarefa (com opção de coluna pré-definida)
function openNewTaskModal(defaultStatus = 'todo') {
    editingCard = null;
    modalTitle.textContent = 'Nova Tarefa';

    taskCreatorInput.disabled = false;
    taskForm.reset();

    taskStatusInput.value = defaultStatus;
    if (taskPriorityInput) taskPriorityInput.value = 'media';

    taskModal.classList.remove('hidden');
    taskModal.classList.add('flex');
    taskNameInput.focus();
}

// Abre modal para Editar Tarefa Existente
function openEditModal(card) {
    editingCard = card;
    modalTitle.textContent = 'Editar Tarefa';

    taskNameInput.value = card.dataset.name || '';
    taskAssigneeInput.value = card.dataset.assignee || '';

    if (taskPriorityInput) {
        taskPriorityInput.value = card.dataset.priority || 'media';
    }

    taskCreatorInput.value = card.dataset.creator || '';
    taskCreatorInput.disabled = true; // Criador permanece inalterável na edição

    const currentColumn = card.closest('.column');
    if (currentColumn) {
        taskStatusInput.value = currentColumn.getAttribute('data-status');
    }

    taskModal.classList.remove('hidden');
    taskModal.classList.add('flex');
    taskNameInput.focus();
}

// Fecha o modal e limpa estado
function closeModal() {
    taskModal.classList.add('hidden');
    taskModal.classList.remove('flex');
    taskForm.reset();
    editingCard = null;
}

// Listeners de abertura
addBtn.addEventListener('click', () => openNewTaskModal('todo'));
if (headerAddBtn) {
    headerAddBtn.addEventListener('click', () => openNewTaskModal('todo'));
}

// Botões "+" rápidos no cabeçalho de cada coluna
document.querySelectorAll('.quick-add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const targetColumn = btn.getAttribute('data-column') || 'todo';
        openNewTaskModal(targetColumn);
    });
});

// Listeners de fechamento
closeModalBtn.addEventListener('click', closeModal);
if (closeModalXBtn) closeModalXBtn.addEventListener('click', closeModal);

// Fechar ao clicar no backdrop escuro
taskModal.addEventListener('click', (e) => {
    if (e.target === taskModal) {
        closeModal();
    }
});

// Fechar com tecla Escape
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !taskModal.classList.contains('hidden')) {
        closeModal();
    }
});

// ==========================================
// SUBMISSÃO DO FORMULÁRIO (CRIAR / EDITAR)
// ==========================================
taskForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const taskName = taskNameInput.value.trim();
    const taskStatus = taskStatusInput.value;
    const taskPriority = taskPriorityInput ? taskPriorityInput.value : 'media';
    const taskAssignee = taskAssigneeInput.value.trim();
    const taskCreator = taskCreatorInput.value.trim();

    if (!taskName || !taskAssignee || (!editingCard && !taskCreator)) {
        return;
    }

    const targetColumn = document.getElementById(taskStatus);
    const targetCardsContainer = targetColumn ? targetColumn.querySelector('.cards-container') : null;

    if (!targetCardsContainer) return;

    if (editingCard) {
        // === FLUXO DE EDIÇÃO ===
        editingCard.dataset.name = taskName;
        editingCard.dataset.assignee = taskAssignee;
        editingCard.dataset.priority = taskPriority;

        // Atualiza elementos visuais internos
        const nameEl = editingCard.querySelector('.task-name');
        if (nameEl) nameEl.textContent = taskName;

        const priorityBadgeEl = editingCard.querySelector('.priority-badge');
        if (priorityBadgeEl) {
            priorityBadgeEl.outerHTML = getPriorityBadgeHTML(taskPriority);
        }

        const assigneeEl = editingCard.querySelector('.task-assignee-text');
        if (assigneeEl) assigneeEl.textContent = taskAssignee;

        const avatarEl = editingCard.querySelector('.avatar-badge');
        if (avatarEl) {
            avatarEl.textContent = (taskAssignee.charAt(0) || 'U').toUpperCase();
            avatarEl.className = `avatar-badge w-5 h-5 rounded-full ${getAvatarClasses(taskAssignee)} font-bold text-[10px] flex items-center justify-center`;
        }

        // Se o status/coluna mudou, move o card para o topo da nova coluna
        const currentColumn = editingCard.closest('.column');
        const currentStatus = currentColumn ? currentColumn.getAttribute('data-status') : null;

        if (currentStatus !== taskStatus) {
            targetCardsContainer.insertBefore(editingCard, targetCardsContainer.firstChild);
            notifyBackendMove(editingCard.id, taskStatus);
        }

    } else {
        // === FLUXO DE CRIAÇÃO ===
        const newTaskId = `task-${Date.now()}`;
        const newCard = document.createElement('div');
        newCard.className = 'card bg-white p-4 rounded-xl border border-slate-200/90 shadow-xs hover:shadow-md hover:border-slate-300 transition-all duration-200 cursor-grab active:cursor-grabbing flex flex-col gap-2.5 group shrink-0 select-none';
        newCard.draggable = true;
        newCard.id = newTaskId;

        newCard.dataset.name = taskName;
        newCard.dataset.assignee = taskAssignee;
        newCard.dataset.creator = taskCreator;
        newCard.dataset.priority = taskPriority;

        const initialLetter = (taskAssignee.charAt(0) || 'U').toUpperCase();
        const avatarColor = getAvatarClasses(taskAssignee);
        const priorityBadge = getPriorityBadgeHTML(taskPriority);

        newCard.innerHTML = `
            <div class="flex items-center justify-between gap-2">
                ${priorityBadge}
                <div class="flex items-center gap-1 opacity-80 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                    <button class="edit-btn p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition" title="Editar tarefa">
                        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                        </svg>
                    </button>
                    <button class="delete-btn p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-md transition" title="Excluir tarefa">
                        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                    </button>
                </div>
            </div>
            <h3 class="task-name font-semibold text-slate-800 text-sm leading-snug break-words">${taskName}</h3>
            <div class="flex items-center justify-between text-xs text-slate-500 pt-2 border-t border-slate-100">
                <div class="flex items-center gap-1.5">
                    <span class="avatar-badge w-5 h-5 rounded-full ${avatarColor} font-bold text-[10px] flex items-center justify-center">${initialLetter}</span>
                    <span class="task-assignee-text text-slate-600 font-medium">${taskAssignee}</span>
                </div>
                <span class="task-creator-text text-[11px] text-slate-400">Por: ${taskCreator}</span>
            </div>
        `;

        setupCardEvents(newCard);
        // Insere o novo card no topo da coluna escolhida
        targetCardsContainer.insertBefore(newCard, targetCardsContainer.firstChild);

        console.log(`Nova tarefa criada: ${newTaskId} na coluna ${taskStatus}`);
        notifyBackendMove(newTaskId, taskStatus);
    }

    closeModal();
    updateCounters();
});

// ==========================================
// FILTRO E BUSCA EM TEMPO REAL
// ==========================================
if (searchInput) {
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.trim().toLowerCase();

        document.querySelectorAll('.card').forEach(card => {
            const name = (card.dataset.name || '').toLowerCase();
            const assignee = (card.dataset.assignee || '').toLowerCase();
            const creator = (card.dataset.creator || '').toLowerCase();
            const priority = (card.dataset.priority || '').toLowerCase();

            const matches = !query ||
                name.includes(query) ||
                assignee.includes(query) ||
                creator.includes(query) ||
                priority.includes(query);

            if (matches) {
                card.style.display = 'flex';
            } else {
                card.style.display = 'none';
            }
        });

        updateCounters();
    });
}

// ==========================================
// INICIALIZAÇÃO
// ==========================================
// Aplica os eventos em todos os cards já presentes no HTML
document.querySelectorAll('.card').forEach(card => {
    setupCardEvents(card);
});

// Atualiza contadores iniciais
updateCounters();
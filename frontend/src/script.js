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

// ==========================================
// COMUNICAÇÃO COM A API GATEWAY
// ==========================================

// Usa o mesmo host da página: funciona em localhost e quando outra máquina da rede abre o Kanban
const API_URL = `http://${window.location.hostname || 'localhost'}:4000`;

const REQUEST_TIMEOUT_MS = 8000;

// Identificador que acompanha a ação do usuário por todos os serviços (logs da API, fila e worker).
// crypto.randomUUID só existe em contexto seguro (localhost/https); fora disso usa um fallback.
function newCorrelationId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Erro de HTTP com status, para decidir se vale tentar de novo
class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

// Chamada à API com timeout. GET/PUT/DELETE são idempotentes e ganham retry com
// backoff exponencial em falhas de rede/5xx; POST não, para não criar a tarefa duas vezes.
async function api(method, path, body) {
    const correlationId = newCorrelationId();
    const retries = method === 'POST' ? 0 : 2;

    for (let attempt = 0; ; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const res = await fetch(`${API_URL}${path}`, {
                method,
                headers: {
                    'X-Correlation-Id': correlationId,
                    ...(body ? { 'Content-Type': 'application/json' } : {})
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal
            });
            const data = await res.json().catch(() => ({}));
            console.log(`[API] ${method} ${path} -> ${res.status} (réplica ${res.headers.get('X-Instance')}, correlationId ${correlationId})`);
            if (!res.ok) {
                throw new ApiError(data.message || `HTTP ${res.status}`, res.status);
            }
            return data;
        } catch (err) {
            // 4xx é erro do pedido: repetir não adianta
            const transient = !(err instanceof ApiError) || err.status >= 500;
            if (attempt >= retries || !transient) {
                throw err.name === 'AbortError' ? new Error(`Tempo esgotado (${REQUEST_TIMEOUT_MS / 1000}s)`) : err;
            }
            const delay = 300 * 2 ** attempt;
            console.warn(`[API] Falha em ${method} ${path}, nova tentativa em ${delay}ms:`, err.message);
            await sleep(delay);
        } finally {
            clearTimeout(timer);
        }
    }
}

// Mostra erro e ressincroniza a tela com o servidor (desfaz mudanças otimistas)
function handleApiError(action, err) {
    console.warn(`[API Gateway] Falha ao ${action}:`, err.message);
    alert(`Não foi possível ${action}: ${err.message}`);
    loadTasks();
}

// Notifica a API Gateway da movimentação (o card já foi movido na tela)
async function notifyBackendMove(taskId, newColumn) {
    console.log(`[API Sync] Tarefa ${taskId} movida para ${newColumn}`);
    try {
        await api('PUT', `/tasks/${taskId}/move`, { newColumn });
    } catch (err) {
        handleApiError('mover a tarefa', err);
    }
}

// ==========================================
// RENDERIZAÇÃO DOS CARDS
// ==========================================
const cardDomId = (taskId) => `task-${taskId}`;

function getCardsContainer(status) {
    const column = document.querySelector(`.column[data-status="${status}"]`);
    return column ? column.querySelector('.cards-container') : null;
}

// Monta o card. Textos do usuário entram via textContent (nunca innerHTML) para evitar XSS
function createCardElement(task) {
    const card = document.createElement('div');
    card.className = 'card bg-white p-4 rounded-xl border border-slate-200/90 shadow-xs hover:shadow-md hover:border-slate-300 transition-all duration-200 cursor-grab active:cursor-grabbing flex flex-col gap-2.5 group shrink-0 select-none';
    card.draggable = true;
    card.id = cardDomId(task.id);
    card.dataset.id = task.id;

    card.innerHTML = `
        <div class="flex items-center justify-between gap-2">
            <span class="priority-badge"></span>
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
        <h3 class="task-name font-semibold text-slate-800 text-sm leading-snug break-words"></h3>
        <div class="flex items-center justify-between text-xs text-slate-500 pt-2 border-t border-slate-100">
            <div class="flex items-center gap-1.5">
                <span class="avatar-badge"></span>
                <span class="task-assignee-text text-slate-600 font-medium"></span>
            </div>
            <span class="task-creator-text text-[11px] text-slate-400"></span>
        </div>
    `;

    setupCardEvents(card);
    fillCard(card, task);
    return card;
}

// Preenche/atualiza os dados visuais de um card
function fillCard(card, task) {
    card.dataset.name = task.title;
    card.dataset.assignee = task.assignee;
    card.dataset.creator = task.creator;
    card.dataset.priority = task.priority;

    card.querySelector('.priority-badge').outerHTML = getPriorityBadgeHTML(task.priority);
    card.querySelector('.task-name').textContent = task.title;
    card.querySelector('.task-assignee-text').textContent = task.assignee;
    card.querySelector('.task-creator-text').textContent = `Por: ${task.creator}`;

    const avatarEl = card.querySelector('.avatar-badge');
    avatarEl.textContent = (task.assignee.charAt(0) || 'U').toUpperCase();
    avatarEl.className = `avatar-badge w-5 h-5 rounded-full ${getAvatarClasses(task.assignee)} font-bold text-[10px] flex items-center justify-center`;
}

// Cria ou atualiza o card de uma tarefa. É idempotente: a resposta HTTP e o evento
// do WebSocket podem chegar em qualquer ordem sem duplicar cards.
function upsertCard(task, { prepend = false } = {}) {
    if (!task) return;
    const container = getCardsContainer(task.status);
    if (!container) return;

    let card = document.getElementById(cardDomId(task.id));
    if (card) {
        fillCard(card, task);
        // Só reposiciona se mudou de coluna (preserva a ordem escolhida no drag and drop)
        if (card.parentElement !== container) container.appendChild(card);
    } else {
        card = createCardElement(task);
        if (prepend) container.insertBefore(card, container.firstChild);
        else container.appendChild(card);
    }

    applyFilter();
    updateCounters();
}

function removeCard(taskId) {
    const card = document.getElementById(cardDomId(taskId));
    if (card) {
        card.remove();
        updateCounters();
    }
}

// Busca todas as tarefas no servidor e redesenha o quadro
async function loadTasks() {
    try {
        const tasks = await api('GET', '/tasks');
        document.querySelectorAll('.cards-container').forEach(c => c.replaceChildren());
        tasks.forEach(task => upsertCard(task));
        updateCounters();
        console.log(`[API Sync] ${tasks.length} tarefa(s) carregada(s)`);
    } catch (err) {
        console.warn('[API Gateway] Não foi possível carregar as tarefas:', err.message);
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
                removeCard(card.dataset.id);
                api('DELETE', `/tasks/${card.dataset.id}`)
                    .catch(err => handleApiError('excluir a tarefa', err));
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
            console.log(`Tarefa ${draggedCard.dataset.id} posicionada com sucesso na coluna ${newStatus}`);

            // Envia evento para a API e atualiza a interface
            notifyBackendMove(draggedCard.dataset.id, newStatus);
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
taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const taskName = taskNameInput.value.trim();
    const taskStatus = taskStatusInput.value;
    const taskPriority = taskPriorityInput ? taskPriorityInput.value : 'media';
    const taskAssignee = taskAssigneeInput.value.trim();
    const taskCreator = taskCreatorInput.value.trim();

    if (!taskName || !taskAssignee || (!editingCard && !taskCreator)) {
        return;
    }

    const payload = { title: taskName, assignee: taskAssignee, priority: taskPriority, status: taskStatus };
    const card = editingCard;
    closeModal();

    try {
        if (card) {
            // === FLUXO DE EDIÇÃO ===
            const task = await api('PUT', `/tasks/${card.dataset.id}`, payload);
            upsertCard(task);
        } else {
            // === FLUXO DE CRIAÇÃO ===
            const task = await api('POST', '/tasks', { ...payload, creator: taskCreator });
            // Insere o novo card no topo da coluna escolhida
            upsertCard(task, { prepend: true });
            console.log(`Nova tarefa criada: ${task.id} na coluna ${task.status}`);
        }
    } catch (err) {
        handleApiError(card ? 'salvar a tarefa' : 'criar a tarefa', err);
    }
});

// ==========================================
// FILTRO E BUSCA EM TEMPO REAL
// ==========================================
function applyFilter() {
    const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

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

        card.style.display = matches ? 'flex' : 'none';
    });
}

if (searchInput) {
    searchInput.addEventListener('input', () => {
        applyFilter();
        updateCounters();
    });
}

// ==========================================
// INICIALIZAÇÃO
// ==========================================
updateCounters();
loadTasks();

// ==========================================
// WEBSOCKET (Socket.io)
// ==========================================
// Conecta ao WebSocket via balanceador. Só transporte websocket: o long-polling faria
// várias requisições HTTP que poderiam cair em réplicas diferentes da API
const socket = io(API_URL, { transports: ['websocket'] });
let hasConnectedBefore = false;

socket.on('connect', () => {
    console.log('Conectado ao WebSocket da API!', socket.id);
    // Numa reconexão (ex.: a réplica caiu), recarrega tudo para recuperar eventos perdidos
    if (hasConnectedBefore) loadTasks();
    hasConnectedBefore = true;
});

socket.on('disconnect', (reason) => {
    console.warn('[WebSocket] Desconectado:', reason, '- tentando reconectar...');
});

socket.on('connect_error', (err) => {
    console.warn('[WebSocket] Falha ao conectar na API:', err.message);
});

// Eventos repassados pela API a todos os clientes. Formato:
// { eventId, event, correlationId, taskId, task, details, at, origin }
function logEvent(evt) {
    console.log(`Atualização recebida via WebSocket (${evt.event}) - tarefa ${evt.taskId}, correlationId ${evt.correlationId}, origem ${evt.origin}`, evt);
}

socket.on('task_created', (evt) => {
    logEvent(evt);
    upsertCard(evt.task, { prepend: true });
});

socket.on('task_updated', (evt) => {
    logEvent(evt);
    upsertCard(evt.task);
});

socket.on('task_moved', (evt) => {
    logEvent(evt);
    // Se o card já está na coluna, foi este próprio cliente que moveu: nada muda
    upsertCard(evt.task);
});

socket.on('task_deleted', (evt) => {
    logEvent(evt);
    removeCard(evt.taskId);
});

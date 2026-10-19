# Relatório do teste de carga

**Ferramenta:** k6 0.54.0, rodando como contêiner na mesma rede do compose.
**Script:** [kanban.js](kanban.js). **Dados brutos:** [results/summary.json](results/summary.json), [results/queue-depth.csv](results/queue-depth.csv), [results/docker-stats-pico.csv](results/docker-stats-pico.csv).

```bash
docker compose up -d --build
docker compose --profile loadtest run --rm k6
```

## Ambiente

| Item | Valor |
|---|---|
| Máquina | AMD Ryzen 5 5600G (6 núcleos / 12 threads), 16 GB RAM, Windows 10 |
| Docker | Docker Desktop 29.8.1, 12 CPUs e 7,7 GB disponíveis para os contêineres |
| Topologia | 1 load-balancer (Nginx) → **2 réplicas** da API → MySQL; RabbitMQ → **2 réplicas** do worker → history-db |
| Worker | `PROCESSING_DELAY_MS=100` (processamento simulado de 100 ms por evento) |

Todos os serviços rodam na mesma máquina que o gerador de carga, então os números servem para **comparar cenários** deste projeto, não como capacidade absoluta.

## Cenário

Cada usuário virtual (VU) repete o fluxo de uso do quadro:

1. `GET /tasks`: abre o quadro;
2. `POST /tasks`: cria uma tarefa;
3. 3 vezes: `PUT /tasks/:id/move` e depois `GET /tasks`, com pausa de 0,5 s;
4. `PUT /tasks/:id`: edita a tarefa;
5. `DELETE /tasks/:id`: remove a tarefa e espera 1 s.

São 10 requisições por iteração, das quais 6 geram eventos no RabbitMQ. Remover a tarefa no fim mantém o quadro com tamanho estável durante o teste.

| Fase | Duração | VUs |
|---|---|---|
| Aquecimento | 30 s | 0 → 20 |
| Carga normal | 1 min | 20 |
| Subida | 30 s | 20 → 50 |
| Pico | 1 min | 50 |
| Descida | 20 s | 50 → 0 |

Critérios de aceitação (thresholds do k6): **erro < 1%** e **p95 < 500 ms** no geral e em cada endpoint.

## Resultados: API (caminho síncrono)

| Métrica | Valor |
|---|---|
| Requisições | **19.110** em 3min20s |
| Vazão média | **94,8 req/s** |
| Iterações completas | 1.911 (0 interrompidas) |
| Taxa de erro | **0,00%** (100% dos checks OK) |
| Latência p95 geral | **35,1 ms** |
| Latência p99 geral | 305,6 ms |

| Endpoint | Média | Mediana | p90 | **p95** | p99 | Máx |
|---|---|---|---|---|---|---|
| `GET /tasks` | 3,4 | 2,7 | 4,0 | **4,8** | 11,4 | 234,7 |
| `POST /tasks` | 29,5 | 17,4 | 32,4 | **49,9** | 348,2 | 549,7 |
| `PUT /tasks/:id/move` | 30,2 | 17,5 | 31,1 | **46,3** | 391,7 | 695,2 |
| `PUT /tasks/:id` | 31,0 | 17,7 | 33,8 | **49,2** | 378,7 | 688,9 |
| `DELETE /tasks/:id` | 26,6 | 16,7 | 30,4 | **38,6** | 358,7 | 685,4 |

*(valores em ms)*

**Todos os thresholds passaram.**

### Uso de recursos no pico (50 VUs)

| Contêiner | CPU | Memória |
|---|---|---|
| api-gateway (cada réplica) | ~25% | ~68 MB |
| database (MySQL da API) | 35% | 434 MB |
| message-broker | 15% | 155 MB |
| load-balancer | 10% | 12 MB |
| worker (cada réplica) | ~1% | ~24 MB |
| history-db | 6% | 393 MB |

As duas réplicas da API receberam carga equivalente, o que confirma que o balanceamento round-robin está distribuindo as requisições.

## Resultados: fila e worker (caminho assíncrono)

Profundidade da fila `task_updates` ao longo do teste (amostra a cada 5 s):

| Tempo | 0 s | 30 s | 60 s | 90 s | 120 s | 150 s | 180 s | 195 s (pico) | 215 s |
|---|---|---|---|---|---|---|---|---|---|
| Mensagens | 0 | 118 | 722 | 1.330 | 2.633 | 4.813 | 7.536 | **8.115** | 7.792 |

A API publicou cerca de **57 eventos/s**, enquanto os 2 workers processam cerca de **18 eventos/s**. A fila absorveu a diferença e chegou a ~8.100 mensagens no pico. Mesmo assim, **a latência da API não foi afetada**: é o desacoplamento que justifica usar mensageria assíncrona para o histórico. A DLQ ficou com **0 mensagens** durante todo o teste.

### Escalando o worker

Vazão de drenagem da fila medida logo após o teste, durante 30 s:

| Réplicas do worker | Vazão |
|---|---|
| 2 | **18 msg/s** |
| 6 (`docker compose up -d --scale worker=6`) | **55 msg/s** |

O ganho é praticamente linear (3× réplicas → ~3× vazão), porque os workers são consumidores concorrentes sem estado compartilhado, e a idempotência garante que reentregas não geram duplicatas. **Com 6 workers, a vazão do processamento acompanha a taxa de eventos do pico.**

### Integridade (nenhuma perda, nenhuma duplicata)

Depois que a fila esvaziou, conferimos a tabela `historico` contra o esperado (1.911 iterações × 6 eventos):

| Evento | Esperado | Gravado |
|---|---|---|
| `task_created` | 1.911 | 1.911 |
| `task_moved` | 5.733 | 5.733 |
| `task_updated` | 1.911 | 1.911 |
| `task_deleted` | 1.911 | 1.911 |
| **Total** | **11.466** | **11.466** (11.466 `event_id` distintos) |

Os eventos foram processados por 6 instâncias diferentes do worker (2 fixas + 4 do teste de escalonamento).

```sql
-- no history-db
SELECT evento, COUNT(*), COUNT(DISTINCT event_id) FROM historico
WHERE correlation_id LIKE 'k6-%' GROUP BY evento;
```

## Análise

* **O caminho síncrono sobra folga.** O p95 de 35 ms está 14× abaixo do limite de 500 ms, com 50 usuários simultâneos e sem erros. O `GET /tasks` é o mais rápido (p95 de 5 ms), porque é só uma leitura simples num quadro pequeno.
* **As escritas têm cauda longa.** O p95 das escritas fica em ~50 ms, mas o p99 sobe para ~350–390 ms. Cada escrita faz uma transação no MySQL e espera a confirmação do RabbitMQ (*publisher confirm*) com mensagem persistente. **Hipótese a confirmar:** o RabbitMQ só confirma depois de gravar em disco, e essa gravação acontece em lotes, o que gera picos ocasionais. Para confirmar, seria preciso medir separadamente o tempo de banco e o tempo de publish nos logs da API.
* **O gargalo é o worker, por decisão de projeto.** Com 100 ms de processamento simulado e 2 réplicas, o histórico ficou atrasado em relação às ações do usuário. Em consistência eventual, isso significa que o histórico demorou alguns minutos para ficar em dia depois do pico, mas nenhuma mensagem foi perdida, e escalar o worker resolveu proporcionalmente.
* **O tamanho do quadro afeta o GET.** O teste remove as tarefas a cada iteração, então o quadro nunca passou de algumas dezenas de cards. Com milhares de cards, o `GET /tasks`, que hoje retorna todos sem paginação, ficaria mais lento.

## Melhorias identificadas

1. Dimensionar o número de workers pela taxa de eventos esperada: neste teste, 6 réplicas para 57 eventos/s.
2. Paginar o `GET /tasks`, ou filtrar por coluna, se o quadro crescer.
3. Instrumentar o tempo de banco e de publish separadamente, para investigar o p99 das escritas.

# Arquitetura

Este documento descreve a arquitetura do Kanban Distribuído no modelo C4 (níveis 1 e 2) e o fluxo principal em um diagrama de sequência. As decisões e seus trade-offs estão nos [ADRs](adr/README.md).

## Nível 1: Contexto do sistema

Quem usa o sistema e do que ele depende fora dele.

```mermaid
flowchart TB
    user["<b>Membro da equipe</b><br/><i>[Pessoa]</i><br/>Organiza tarefas no quadro<br/>To Do / Doing / Done"]

    kanban["<b>Kanban Distribuído</b><br/><i>[Sistema de software]</i><br/>Quadro colaborativo em tempo real:<br/>criar, editar, mover e excluir tarefas,<br/>com histórico de todas as alterações"]

    cdn["<b>CDNs públicas</b><br/><i>[Sistema externo]</i><br/>Tailwind CSS, cliente Socket.io<br/>e Google Fonts"]

    user -- "Usa pelo navegador<br/>[HTTP + WebSocket]" --> kanban
    user -. "O navegador baixa bibliotecas<br/>[HTTPS]" .-> cdn

    classDef person fill:#08427b,stroke:#052e56,color:#fff
    classDef system fill:#1168bd,stroke:#0b4884,color:#fff
    classDef external fill:#999,stroke:#6b6b6b,color:#fff
    class user person
    class kanban system
    class cdn external
```

Vários membros usam o quadro ao mesmo tempo, de máquinas diferentes. Quando um deles altera uma tarefa, todos os outros veem a mudança sem recarregar a página.

## Nível 2: Contêineres

Os contêineres dentro do sistema, com tecnologia, réplicas e protocolo de cada comunicação. Tudo sobe com `docker compose up`.

```mermaid
flowchart TB
    user["<b>Membro da equipe</b><br/><i>[Pessoa]</i>"]

    subgraph kanban ["Kanban Distribuído"]
        direction TB

        spa["<b>Aplicação web</b><br/><i>[JavaScript puro, no navegador]</i><br/>Quadro com drag and drop,<br/>gera o correlation id de cada ação"]

        web["<b>frontend</b><br/><i>[Contêiner: Nginx]</i><br/>Serve HTML/CSS/JS estáticos<br/>porta 3000"]

        lb["<b>load-balancer</b><br/><i>[Contêiner: Nginx]</i><br/>Round-robin entre as réplicas da API,<br/>failover e upgrade para WebSocket<br/>porta 4000"]

        api["<b>api-gateway</b> ×2<br/><i>[Contêiner: Node.js, Express, Socket.io]</i><br/>REST de tarefas, publica eventos<br/>e repassa eventos aos navegadores"]

        db[("<b>database</b><br/><i>[Contêiner: MySQL 8]</i><br/>Tarefas e colunas")]

        mq["<b>message-broker</b><br/><i>[Contêiner: RabbitMQ]</i><br/>Exchange fanout kanban.events,<br/>fila task_updates e DLQ"]

        worker["<b>worker</b> ×2<br/><i>[Contêiner: Node.js, amqplib]</i><br/>Processa eventos de forma<br/>idempotente e grava o histórico"]

        hdb[("<b>history-db</b><br/><i>[Contêiner: MySQL 8]</i><br/>Histórico de eventos")]
    end

    user -- "Usa" --> spa
    spa -- "Baixa a página<br/>[HTTP]" --> web
    spa -- "Chamadas REST [HTTP/JSON]<br/>Eventos em tempo real [WebSocket]" --> lb
    lb -- "Encaminha<br/>[HTTP / WebSocket]" --> api
    api -- "Lê e grava tarefas<br/>[SQL, síncrono]" --> db
    api -- "Publica eventos [AMQP]<br/>e consome o fanout" --> mq
    mq -- "Entrega task_updates<br/>[AMQP, assíncrono]" --> worker
    worker -- "Grava histórico<br/>[SQL]" --> hdb

    classDef person fill:#08427b,stroke:#052e56,color:#fff
    classDef container fill:#438dd5,stroke:#2e6295,color:#fff
    classDef store fill:#438dd5,stroke:#2e6295,color:#fff
    class user person
    class spa,web,lb,api,mq,worker container
    class db,hdb store
```

| Contêiner | Responsabilidade | Estado | Réplicas | Health check |
|---|---|---|---|---|
| frontend | Servir os arquivos estáticos | — | 1 | `GET /health` |
| load-balancer | Distribuir requisições e WebSockets; failover | — | 1 | `GET /lb-health` |
| api-gateway | Regras e validação das tarefas; publicar e repassar eventos | `database` | 2 | `GET /health` |
| message-broker | Transporte assíncrono e durável dos eventos | filas duráveis | 1 | `rabbitmq-diagnostics ping` |
| worker | Histórico de alterações (processamento em segundo plano) | `history-db` | 2 | `GET :8080/health` |
| database / history-db | Persistência | — | 1 cada | `mysqladmin ping` |

A API e o worker não compartilham banco: o único caminho entre eles é o broker ([ADR 0002](adr/0002-banco-por-servico.md)).

## Fluxo principal: mover um card

O usuário A arrasta um card. O usuário B, conectado em **outra réplica** da API, vê o card se mover, e o worker registra o histórico.

```mermaid
sequenceDiagram
    autonumber
    actor UA as Usuário A
    participant NA as Navegador A
    participant LB as load-balancer
    participant API1 as api-gateway (réplica 1)
    participant DB as database
    participant MQ as RabbitMQ
    participant API2 as api-gateway (réplica 2)
    participant NB as Navegador B
    participant W as worker
    participant HDB as history-db

    Note over NB,API2: B já tem um WebSocket aberto com a réplica 2 (via load-balancer)

    UA->>NA: Arrasta o card para "Doing"
    NA->>NA: Move o card na tela (otimista)
    NA->>LB: PUT /tasks/7/move {newColumn: "doing"}<br/>X-Correlation-Id: c-123
    LB->>API1: Encaminha (round-robin)
    API1->>DB: SELECT estado anterior
    API1->>DB: UPDATE card SET status = doing
    API1->>MQ: publish kanban.events<br/>{eventId: e-9, event: task_moved, correlationId: c-123}
    MQ-->>API1: Confirmação (publisher confirm)
    API1-->>LB: 200 {success, queued, task}
    LB-->>NA: 200 {success, queued, task}

    par Fanout para as réplicas da API
        MQ->>API1: Evento (fila exclusiva da réplica 1)
        API1->>NA: WebSocket task_moved (card já está na coluna, nada muda)
    and
        MQ->>API2: Evento (fila exclusiva da réplica 2)
        API2->>NB: WebSocket task_moved
        NB->>NB: Move o card para "Doing"
    and Fila do worker
        MQ->>W: Entrega de task_updates
        W->>HDB: INSERT historico (event_id = e-9)
        alt Primeira vez
            HDB-->>W: OK
            W->>MQ: ack
        else Evento repetido (reentrega)
            HDB-->>W: ER_DUP_ENTRY (chave primária)
            W->>MQ: ack sem gravar de novo (idempotência)
        else Erro permanente (3 tentativas)
            W->>MQ: nack → task_updates.dlq
        end
    end
```

Pontos principais:

* **Passos 3 a 10 são síncronos.** O usuário só recebe o 200 depois que a tarefa foi salva no MySQL e o broker confirmou o evento.
* **O restante é assíncrono.** O histórico fica em dia alguns milissegundos depois, ou alguns minutos sob carga pesada: é consistência eventual ([ADR 0004](adr/0004-consistencia-eventual-e-idempotencia.md)).
* **O mesmo `correlationId` (c-123) aparece nos logs** do load-balancer, da réplica 1, da réplica 2 e do worker.

## Contrato dos eventos

Publicados no exchange `kanban.events` (fanout, durável), com mensagens persistentes e `content-type: application/json`. O mesmo objeto é repassado aos navegadores pelo Socket.io, com o nome do evento igual ao campo `event`.

| Campo | Tipo | Descrição |
|---|---|---|
| `eventId` | UUID | Identificador único do evento. Chave de idempotência no worker. |
| `event` | string | `task_created`, `task_updated`, `task_moved` ou `task_deleted` |
| `correlationId` | string | Id da requisição de origem, para rastrear nos logs |
| `taskId` | inteiro | Id da tarefa |
| `task` | objeto ou `null` | Estado da tarefa depois da alteração (`null` em `task_deleted`) |
| `details` | objeto | `task_moved`: `{from, to}`; `task_updated`: `{from, to}` com a tarefa antes e depois; `task_created`: `{status}` |
| `at` | ISO 8601 | Momento em que a API gerou o evento |
| `origin` | string | Instância da API que gerou o evento |

```json
{
  "eventId": "0286133b-f2c1-452a-b940-ca35fbcc16d5",
  "event": "task_moved",
  "correlationId": "c-123",
  "taskId": 7,
  "task": { "id": 7, "title": "Revisar ADRs", "assignee": "Gustavo", "creator": "Helena", "priority": "alta", "status": "doing", "updatedAt": "2026-10-18T02:23:16.649Z" },
  "details": { "from": "todo", "to": "doing" },
  "at": "2026-10-18T02:23:16.649Z",
  "origin": "4bc32e45e397"
}
```

Topologia no RabbitMQ:

| Objeto | Tipo | Propósito |
|---|---|---|
| `kanban.events` | exchange fanout, durável | Recebe todos os eventos da API |
| `task_updates` | fila durável, ligada ao exchange | Consumida pelas réplicas do worker (consumidores concorrentes, `prefetch 1`) |
| `task_updates.dlq` | fila durável | Recebe mensagens rejeitadas pelo worker (dead letter) |
| *(sem nome)* | fila exclusiva por réplica da API | Recebe cópia de cada evento para repassar via Socket.io; é apagada quando a réplica desconecta |

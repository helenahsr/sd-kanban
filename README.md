# Kanban Distribuído

Este é o repositório do nosso projeto de Sistemas Distribuídos. Trata-se de um painel Kanban (To Do, Doing, Done) colaborativo em tempo real, desenvolvido com foco em microsserviços, comunicação assíncrona (filas) e sincronização de estado.

## Arquitetura do Sistema

O projeto roda inteiramente em **Docker** (um único `docker compose up`) e está dividido nos seguintes serviços:

| Serviço | Tecnologia | Réplicas | Estado próprio | Health check |
|---|---|---|---|---|
| **frontend** | Nginx + HTML/CSS/Vanilla JS (porta `3000`) | 1 | — | `GET :3000/health` |
| **load-balancer** | Nginx, round-robin entre as réplicas da API (porta `4000`) | 1 | — | `GET :4000/lb-health` |
| **api-gateway** | Node.js + Express + Socket.io | **2** | MySQL `database` (tarefas) | `GET :4000/health` (via balanceador) |
| **worker** | Node.js + amqplib | **2** | MySQL `history-db` (histórico de eventos) | `GET :8080/health` (interno) |
| **message-broker** | RabbitMQ (painel na porta `15672`) | 1 | filas duráveis | `rabbitmq-diagnostics ping` |
| **database** / **history-db** | MySQL 8.0 | 1 cada | — | `mysqladmin ping` |

A API e o worker **não compartilham banco**: o histórico só chega ao worker pelos eventos do RabbitMQ.

## Pré-requisitos

Antes de começar, certifique-se de ter as seguintes ferramentas instaladas na sua máquina:

1. **[Git](https://git-scm.com/downloads):** Necessário para clonar e versionar o repositório.
2. **[Docker Desktop](https://www.docker.com/products/docker-desktop/):** Obrigatório. Ele já inclui o motor do Docker e o Docker Compose. **Importante:** O aplicativo do Docker Desktop precisa estar aberto e rodando no seu computador antes de executar os comandos.
3. **[Node.js](https://nodejs.org/):** O código vai rodar dentro do Docker, mas ter o Node.js instalado na máquina ajuda o VS Code a reconhecer os comandos e oferecer autocompletar sem acusar erros.

## Como rodar o projeto localmente

**Passo 1: Clonar o repositório**
Abra o terminal e rode:
```bash
git clone <url-desse-repositorio>
cd sd-kanban
```

**Passo 2: Configurar Variáveis de Ambiente (MUITO IMPORTANTE)**
Por questões de segurança, as senhas não estão no GitHub. Você precisa criar um arquivo chamado `.env` na raiz do projeto (mesmo local do `docker-compose.yaml`), ou copiar o `.env.example`, com o seguinte conteúdo:

```env
# Configurações do Banco de Dados (MySQL)
MYSQL_ROOT_PASSWORD=senha_root_segura
MYSQL_DATABASE=kanban
MYSQL_USER=usuario_api
MYSQL_PASSWORD=senha_api_segura

# Configurações do RabbitMQ
RABBITMQ_URL=amqp://message-broker:5672
```

**Passo 3: Subir os Containers**
Na raiz do projeto (certifique-se de que o Docker Desktop está aberto), rode:

```bash
docker compose up -d --build
```
*A flag `-d` libera o terminal e `--build` garante que as imagens mais recentes do nosso código sejam geradas.*

**Passo 4: Acessar a aplicação**
Quando os containers estiverem verdes no Docker Desktop, você pode acessar:

* **Interface do Kanban:** http://localhost:3000
* **API Gateway (via balanceador):** http://localhost:4000 — o header `X-Instance` da resposta mostra qual réplica atendeu
* **Painel do RabbitMQ:** http://localhost:15672 *(Usuário: `guest` | Senha: `guest`)*

## Documentação de arquitetura

* [Arquitetura](docs/arquitetura.md): diagramas C4 (níveis 1 e 2), diagrama de sequência do fluxo principal e contrato dos eventos
* [ADRs](docs/adr/README.md): decisões de arquitetura e trade-offs
* [Relatório do teste de carga](load-test/RELATORIO.md)

## Fluxo distribuído

1. O **Frontend** chama a API REST pelo **load-balancer** (`http://<host>:4000`), enviando um `X-Correlation-Id`.
2. Uma das réplicas da **API Gateway** grava no MySQL (**síncrono**: o usuário precisa da confirmação) e publica o evento no exchange fanout `kanban.events` do RabbitMQ (**assíncrono**: o histórico não precisa travar a resposta).
3. O exchange entrega o evento para:
   * a fila durável `task_updates`, consumida pelas réplicas do **Worker** (consumidores concorrentes), que gravam no `history-db`;
   * uma fila exclusiva de **cada réplica da API**, que repassa o evento via **Socket.io** aos navegadores conectados nela. Assim, quem está na réplica B vê o card movido pela réplica A.

```
navegador ──REST──► load-balancer ──► api-gateway (x2) ──SQL──► database
    ▲                                      │
    └──────────── WebSocket ◄──────────────┤ publish
                                           ▼
                              RabbitMQ (kanban.events, fanout)
                                ├──► task_updates ──► worker (x2) ──SQL──► history-db
                                │         └─(falha)──► task_updates.dlq
                                └──► fila de cada réplica da API ──► Socket.io
```

### Rotas da API

| Método | Rota | Corpo | Evento Socket.io |
|---|---|---|---|
| GET | `/tasks` | — | — |
| POST | `/tasks` | `{ title, assignee, creator, priority, status }` | `task_created` |
| PUT | `/tasks/:id` | `{ title?, assignee?, priority?, status? }` | `task_updated` |
| PUT | `/tasks/:id/move` | `{ newColumn }` | `task_moved` |
| DELETE | `/tasks/:id` | — | `task_deleted` |
| GET | `/health` | — | — |

`status`/`newColumn`: `todo`, `doing` ou `done`. `priority`: `alta`, `media` ou `baixa`.

Eventos do Socket.io têm o formato `{ eventId, event, correlationId, taskId, task, details, at, origin }`.

### Banco de dados

O script [database/init.sql](database/init.sql) cria as tabelas da API automaticamente, mas **só na primeira vez** que o volume do MySQL é criado. A tabela `historico` do `history-db` é criada pelo próprio worker ao subir. Se alterar o script ou a topologia das filas, recrie tudo (apaga os dados):

```bash
docker compose down -v
docker compose up -d --build
```

## Resiliência e observabilidade

* **Idempotência:** cada evento tem um `eventId` (UUID), que é a chave primária do `historico`. Se o mesmo evento chegar duas vezes (reentrega do RabbitMQ ou retry do publisher), o worker registra `Evento duplicado ignorado` e não grava de novo.
* **Timeouts e retry com backoff exponencial + jitter:**
  * conexão ao RabbitMQ e ao MySQL na API e no worker;
  * publicação de eventos, com confirmação do broker e timeout de 5s;
  * queries com timeout de 5s;
  * no frontend, `fetch` com timeout de 8s e retry em GET, PUT e DELETE. O POST não é repetido, para não criar a tarefa duas vezes.
* **DLQ:** mensagens inválidas, ou que falham 3 vezes por erro não transitório, vão para `task_updates.dlq`. Se o erro for transitório (banco fora do ar), o worker segura a mensagem e tenta de novo, sem perda.
* **Balanceador:** se uma réplica cai, o Nginx tenta a outra (`proxy_next_upstream`). O POST nunca é repetido pelo balanceador.
* **Logs estruturados:** todos os serviços escrevem uma linha JSON por evento, com `service`, `instance` e `correlationId`. Para seguir uma requisição por todos os serviços:

  ```bash
  docker compose logs --no-log-prefix load-balancer api-gateway worker | grep <correlationId>
  ```

  O `correlationId` de cada ação aparece no console do navegador (F12).

## Roteiro de falha (demonstração ao vivo)

Antes de cada cenário: abrir http://localhost:3000 em duas abas e o console (F12) em uma delas.

**1. Queda de uma réplica da API → continuidade**
```bash
docker stop sd-kanban-api-gateway-1
```
Continue criando e movendo cards. O balanceador manda tudo para a réplica 2 e as duas abas seguem sincronizadas. A aba que estava conectada na réplica derrubada reconecta o WebSocket sozinha e recarrega o quadro. No console, o `réplica ...` das respostas passa a ser sempre o mesmo. Para voltar: `docker start sd-kanban-api-gateway-1`.
*Testado: 0 erros em 177 requisições contínuas durante a queda.*

**2. Queda de todos os workers → recuperação sem perda**
```bash
docker compose stop worker
```
Mova alguns cards: a interface continua funcionando normalmente. No painel do RabbitMQ (aba *Queues*), a fila `task_updates` acumula mensagens. Depois:
```bash
docker compose start worker
docker compose logs -f worker
```
A fila esvazia e cada evento aparece como `Evento processado`, sem nenhum perdido.

**3. Queda do RabbitMQ → degradação controlada**
```bash
docker compose stop message-broker
```
* `http://localhost:4000/health` passa a responder `"status":"degraded"`.
* Criar e mover tarefas continua funcionando, porque tudo é salvo no MySQL.
* O tempo real passa a valer só para os clientes conectados na mesma réplica.

Ao rodar `docker compose start message-broker`, API e workers reconectam sozinhos (backoff exponencial) e o status volta a `ok`.
*Limitação conhecida:* eventos gerados durante a queda do broker não chegam ao histórico do worker. A correção seria o padrão *transactional outbox* (ver ADRs).

**4. Mensagem duplicada → idempotência**
No painel do RabbitMQ, em *Exchanges* › `kanban.events` › *Publish message*, publique duas vezes o mesmo payload:
```json
{"eventId":"11111111-2222-3333-4444-555555555555","event":"task_moved","correlationId":"demo","taskId":1,"details":{"demo":true},"at":"2026-01-01T00:00:00Z"}
```
Nos logs do worker aparecem uma vez `Evento processado` e uma vez `Evento duplicado ignorado (idempotência)`. Publicar um texto que não é JSON faz a mensagem cair na `task_updates.dlq`.

## Teste de carga

```bash
docker compose --profile loadtest run --rm k6
```

Rampa até 50 usuários simultâneos durante 3min20s. Resultado: **94,8 req/s, 0% de erro, p95 de 35 ms**, sem perda nem duplicata de eventos no worker. O relatório completo está em [load-test/RELATORIO.md](load-test/RELATORIO.md).

## Uso de assistentes de IA

Este projeto utilizou o **Claude Code (Anthropic)** como assistente de programação, para integração entre os serviços, depuração e implementação de resiliência (retry, idempotência, DLQ, réplicas e logs estruturados). Todo o código gerado foi revisado e testado pelo grupo.

## Comandos Úteis do Docker

Se você alterar algo no `package.json` ou o container travar, você pode reconstruir os serviços:

* **Parar tudo:** `docker compose down`
* **Ver logs da API (todas as réplicas):** `docker compose logs -f api-gateway`
* **Reconstruir tudo do zero:** `docker compose up -d --build --force-recreate`

## Divisão de Tarefas do Grupo

### Helena (Orquestração, Mensageria e WebSockets)
* Configurar orquestração do Docker.
* Implementar consumidor RabbitMQ no Worker.
* Configurar Socket.io na API para emitir eventos de movimentação de cards.
* Integrar chamadas da API com as funções de banco de dados.

### Artur (Frontend)
* Refinar visualmente o Kanban (HTML/CSS).
* Implementar renderização dinâmica (via GET na API) para montar os cards na tela.
* Criar fluxo para adicionar novas tarefas (via POST na API).
* Descomentar e testar blocos de Fetch API e Socket.io no arquivo `script.js` para atualizar o Kanban em tempo real.

### Gustavo (Banco de Dados MySQL)
* Criar o script `init.sql` com a tabela principal (`tasks`).
* Estabelecer a conexão Node.js <> MySQL na pasta da API usando variáveis do `.env`.
* Desenvolver as funções CRUD (Consultar, Criar e Atualizar status) e exportá-las para a API usar.
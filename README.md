# Kanban Distribuído

Este é o repositório do nosso projeto de Sistemas Distribuídos. Trata-se de um painel Kanban (To Do, Doing, Done) colaborativo em tempo real, desenvolvido com foco em microsserviços, comunicação assíncrona (filas) e sincronização de estado.

## Arquitetura do Sistema

O projeto roda inteiramente em **Docker** e está dividido nos seguintes serviços:

* **Frontend:** HTML, CSS e Vanilla JS puro (Porta `3000`).
* **API Gateway:** Node.js + Express + Socket.io para rotas principais e tempo real (Porta `4000`).
* **Worker:** Serviço Node.js em background para consumir a fila de mensagens.
* **Message Broker:** RabbitMQ para comunicação assíncrona entre API e Worker (Painel na porta `15672`).
* **Database:** MySQL 8.0 para persistência dos dados.

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
Por questões de segurança, as senhas não estão no GitHub. Você precisa criar um arquivo chamado `.env` na raiz do projeto (mesmo local do `docker-compose.yml`) e colar o seguinte conteúdo:

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
docker-compose up -d --build
```
*A flag `-d` libera o terminal e `--build` garante que as imagens mais recentes do nosso código sejam geradas.*

**Passo 4: Acessar a aplicação**
Quando os containers estiverem verdes no Docker Desktop, você pode acessar:

* **Interface do Kanban:** http://localhost:3000
* **API Gateway:** http://localhost:4000
* **Painel do RabbitMQ:** http://localhost:15672 *(Usuário: `guest` | Senha: `guest`)*

## Comandos Úteis do Docker

Se você alterar algo no `package.json` ou o container travar, você pode reconstruir os serviços:

* **Parar tudo:** `docker-compose down`
* **Ver logs da API:** `docker logs sd-kanban-api-gateway-1 -f`
* **Reconstruir tudo do zero:** `docker-compose up -d --build --force-recreate`

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
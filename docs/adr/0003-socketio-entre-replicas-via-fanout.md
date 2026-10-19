# ADR 0003: Tempo real entre réplicas da API via exchange fanout, sem sticky session

**Status:** Aceito
**Data:** 2026-10-18

## Contexto

O quadro é colaborativo: quando alguém move um card, todos os navegadores abertos precisam ver a mudança. Isso é feito com Socket.io (WebSocket) na api-gateway.

Com **uma** réplica, bastava `io.emit()`. Com **duas** réplicas atrás de um balanceador, cada navegador fica conectado a uma réplica, e o `io.emit()` só alcança os clientes da réplica que tratou a requisição. O usuário B, conectado na réplica 2, não veria o card movido pelo usuário A através da réplica 1.

Além disso, o Socket.io começa por padrão com *long-polling* HTTP e só depois faz upgrade para WebSocket. O polling faz várias requisições HTTP que, com round-robin, cairiam em réplicas diferentes, e o handshake quebra.

## Decisão

1. **Cada réplica da API cria uma fila exclusiva** (sem nome, apagada quando a réplica desconecta) ligada ao exchange **fanout** `kanban.events`. Todo evento publicado por qualquer réplica chega a todas as réplicas, e cada uma faz `io.emit()` para os **seus** clientes.
2. A réplica que publicou **não** faz `io.emit()` diretamente: ela também recebe o evento pela própria fila. Assim existe um único caminho de entrega, sem duplicação.
3. O cliente Socket.io usa **apenas o transporte `websocket`** (`transports: ['websocket']`). Uma conexão WebSocket é uma única conexão TCP, que fica presa à réplica escolhida no momento da conexão. Por isso **não é preciso sticky session** e o balanceador continua em round-robin puro.
4. **Degradação controlada:** se o broker estiver fora do ar, a réplica faz `io.emit()` local. Os clientes conectados nela continuam recebendo as atualizações, e os da outra réplica não recebem as atualizações enquanto o broker estiver fora; recuperam o estado quando reconectarem o WebSocket ou recarregarem a página (o frontend recarrega o quadro a cada reconexão).

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| **`@socket.io/redis-adapter`** (solução oficial) | Exige um Redis só para isso, mais um contêiner com seu próprio modo de falha. Já tínhamos um broker capaz de fazer pub/sub. Continua sendo a escolha natural se o projeto crescer (salas, acks entre réplicas). |
| **Sticky session no Nginx (`ip_hash`)** | Resolve o polling, mas não a entrega entre réplicas. Além disso, todos os navegadores atrás do mesmo NAT (ou todos em `localhost` na demo) cairiam na mesma réplica, e o balanceamento não apareceria. |
| **Só `io.emit()` local** | Quebra a colaboração: usuários em réplicas diferentes deixam de se ver. |
| **Polling do frontend** (`GET /tasks` a cada N segundos) | Sem tempo real, com carga constante na API e no MySQL proporcional ao número de abas abertas. |

## Consequências

**Positivas**
* Testado com 6 clientes WebSocket, 3 conectados em cada réplica: todos receberam todos os eventos, inclusive os gerados pela outra réplica.
* Nenhum serviço novo: o RabbitMQ já fazia parte da arquitetura.
* O caminho do tempo real é o mesmo do histórico (exchange `kanban.events`), com um único formato de evento ([contrato](../arquitetura.md#contrato-dos-eventos)).

**Negativas / aceitas**
* **O tempo real depende do broker.** Sem ele, a atualização vale só para a mesma réplica (degradação controlada, roteiro de falha cenário 3).
* **Sem fallback para long-polling.** Redes que bloqueiam WebSocket (alguns proxies corporativos) não terão tempo real, só a carga inicial e o recarregamento.
* **Mais latência que o emit direto:** cada notificação passa pelo broker (alguns milissegundos a mais).
* Eventos entregues enquanto um navegador estava desconectado são perdidos para ele. Isso é compensado recarregando o quadro inteiro na reconexão, o que é simples mas custa um `GET /tasks` completo.

# ADR 0001: REST síncrono para comandos do usuário e RabbitMQ assíncrono para o histórico

**Status:** Aceito
**Data:** 2026-10-18

## Contexto

O trabalho exige pelo menos uma comunicação síncrona e uma assíncrona, cada uma justificada. No Kanban há dois tipos de operação com necessidades diferentes:

1. **Comandos do usuário** (criar, editar, mover, excluir uma tarefa). Quem arrasta o card precisa saber **na hora** se deu certo. A criação ainda precisa devolver o `id` gerado pelo banco, para o card poder ser movido depois.
2. **Efeitos secundários** de cada comando: registrar o histórico e avisar os outros navegadores. Nenhum dos dois deveria atrasar a resposta ao usuário, e uma falha neles não deveria impedir o comando principal.

## Decisão

* **Síncrono (REST/HTTP + JSON):** navegador → load-balancer → api-gateway → MySQL. A API só responde depois de gravar no banco e de o broker confirmar o recebimento do evento.
* **Assíncrono (RabbitMQ/AMQP):** depois de gravar, a API publica um evento no exchange `kanban.events`. O worker consome o evento e grava o histórico no próprio banco, no seu ritmo. As réplicas da API também recebem o evento para repassar aos navegadores ([ADR 0003](0003-socketio-entre-replicas-via-fanout.md)).

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| **Tudo síncrono** (API chama o worker por HTTP) | Se o worker estiver lento ou fora do ar, a requisição do usuário fica lenta ou falha. Acopla a disponibilidade do quadro à do histórico. |
| **Tudo assíncrono** (API só enfileira; o worker grava a tarefa) | O usuário não recebe confirmação nem o `id` da tarefa criada. Teria que consultar depois (polling) ou esperar a notificação, o que complica o frontend para pouco ganho. |
| **gRPC no lugar de REST** | O cliente é um navegador, e gRPC no navegador exige gRPC-Web e um proxy extra. REST com JSON é nativo no `fetch`. |
| **Kafka ou Redpanda no lugar de RabbitMQ** | Os pontos fortes do Kafka (log retido, replay, partições, alta vazão) não são necessários aqui. O RabbitMQ oferece de forma nativa o que precisamos (fanout, ack/nack, dead letter, painel web) e é mais leve para rodar numa máquina de laboratório. |
| **Redis Streams** | Funcionaria, mas o roteamento (fanout, DLQ) teria que ser feito à mão e o grupo já conhecia o RabbitMQ. |

## Consequências

**Positivas**
* A latência que o usuário percebe não depende do worker. No teste de carga, a fila chegou a ~8.100 mensagens acumuladas e o p95 da API continuou em 35 ms ([relatório](../../load-test/RELATORIO.md)).
* O worker pode ficar fora do ar sem afetar o quadro: os eventos esperam na fila durável e são processados quando ele volta (roteiro de falha, cenário 2).
* O worker escala de forma independente: 2 → 6 réplicas levaram a vazão de 18 → 55 eventos/s.

**Negativas / aceitas**
* **Consistência eventual:** o histórico pode ficar atrasado em relação ao quadro ([ADR 0004](0004-consistencia-eventual-e-idempotencia.md)).
* **Mais uma peça para operar** (o broker), com seus próprios modos de falha.
* **Escrita dupla:** a API grava no MySQL e depois publica no broker, e essas duas operações não são atômicas. Se o broker estiver fora do ar nesse intervalo, a tarefa é salva mas o evento não chega ao histórico. Detalhes e mitigação futura (outbox) no [ADR 0004](0004-consistencia-eventual-e-idempotencia.md).

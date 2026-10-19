# ADR 0004: Consistência eventual com entrega at-least-once, consumidor idempotente e DLQ

**Status:** Aceito
**Data:** 2026-10-18

## Contexto

O histórico é gravado pelo worker a partir de eventos do RabbitMQ ([ADR 0001](0001-rest-sincrono-e-rabbitmq-assincrono.md)). Num sistema distribuído, o mesmo evento **pode chegar mais de uma vez**:

* o worker grava no banco, mas cai antes de enviar o `ack`, e o RabbitMQ reentrega a mensagem para outra réplica;
* a API não recebe a confirmação do broker a tempo, publica de novo (retry), e o evento passa a existir duas vezes na fila.

O trabalho exige que processar a mesma mensagem duas vezes não gere efeito duplicado. Também é preciso decidir o que fazer com mensagens que **nunca** vão dar certo (JSON inválido, campos faltando), para que elas não travem a fila.

## Decisão

1. **Entrega at-least-once:** fila e mensagens duráveis/persistentes, publisher confirms na API e `ack` manual no worker, enviado só depois de gravar.
2. **Consumidor idempotente:** cada evento recebe um `eventId` (UUID) na API, e esse `eventId` é a **chave primária** da tabela `historico`. Uma segunda gravação do mesmo evento falha com `ER_DUP_ENTRY`: o worker registra `Evento duplicado ignorado (idempotência)` e dá `ack` sem alterar nada. A garantia fica no banco, então funciona **entre réplicas** do worker e sobrevive a reinícios.
3. **Classificação de falhas no worker:**
   * *transitória* (banco fora do ar, timeout): retry com backoff exponencial **sem limite**, segurando a mensagem. Com `prefetch 1` o resto espera na fila, sem perda;
   * *permanente* (dado inválido, erro de SQL): 3 tentativas e depois `nack` sem requeue, o que envia a mensagem para a **dead letter queue** `task_updates.dlq`;
   * *mensagem malformada*: vai direto para a DLQ.
4. **Consistência eventual aceita:** o quadro (MySQL da API) é a fonte da verdade e é atualizado de forma síncrona. O histórico converge depois.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| **Exactly-once de verdade** (transação distribuída / 2PC entre MySQL e RabbitMQ) | O RabbitMQ não participa de transações XA. Mesmo onde é possível, 2PC bloqueia quando um participante cai, que é exatamente o cenário que queremos tolerar. *At-least-once* com idempotência dá o mesmo efeito observável. |
| **At-most-once** (`ack` automático) | Uma réplica que cai no meio do processamento perde o evento. |
| **Deduplicação em memória** (Set de `eventId` no worker) | Não funciona entre réplicas e é perdida a cada reinício. |
| **Deduplicar por conteúdo** (taskId + tipo + horário) | Dois movimentos legítimos e idênticos em sequência seriam descartados por engano. O `eventId` distingue "repetição da mesma mensagem" de "nova ação igual". |
| **Requeue infinito para qualquer erro** (sem DLQ) | Uma mensagem inválida volta para a fila para sempre e consome o worker em loop (*poison message*). |

## Consequências

**Positivas**
* No teste de carga, **11.466 eventos esperados, 11.466 gravados, 11.466 `event_id` distintos**, processados por 6 instâncias diferentes do worker ([relatório](../../load-test/RELATORIO.md)).
* Duplicata injetada manualmente: gravada uma vez e ignorada na segunda, mesmo caindo em réplicas diferentes do worker (roteiro de falha, cenário 4).
* Mensagens problemáticas ficam visíveis e inspecionáveis na DLQ, pelo painel do RabbitMQ.

**Negativas / aceitas**
* **Atraso do histórico:** no pico do teste de carga, a fila chegou a ~8.100 mensagens e o histórico levou alguns minutos para ficar em dia com 2 workers.
* **Problema da escrita dupla não resolvido:** a API faz `UPDATE` no MySQL e depois `publish` no RabbitMQ. Se o broker estiver fora do ar, a tarefa é salva mas o evento **não** chega ao histórico (a API registra o erro em log e avisa só os clientes locais). A solução seria o padrão **transactional outbox**: gravar o evento numa tabela `outbox` na **mesma transação** da tarefa, com um processo separado publicando a partir dela. Ficou fora do escopo por tempo, e está documentado como limitação conhecida no roteiro de falha.
* **A DLQ não é reprocessada automaticamente:** é preciso intervir manualmente (mover as mensagens de volta pelo painel depois de corrigir a causa).

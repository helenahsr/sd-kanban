# Architecture Decision Records (ADRs)

Cada ADR registra uma decisão de arquitetura relevante: o contexto, as alternativas consideradas e o trade-off aceito.

| # | Decisão | Status |
|---|---|---|
| [0001](0001-rest-sincrono-e-rabbitmq-assincrono.md) | REST síncrono para comandos do usuário e RabbitMQ assíncrono para o histórico | Proposto |
| [0002](0002-banco-por-servico.md) | Um banco por serviço (API e worker não compartilham dados) | Proposto |
| [0003](0003-socketio-entre-replicas-via-fanout.md) | Tempo real entre réplicas da API via exchange fanout, sem sticky session | Proposto |
| [0004](0004-consistencia-eventual-e-idempotencia.md) | Consistência eventual com entrega at-least-once, consumidor idempotente e DLQ | Proposto |
| [0005](0005-balanceamento-e-politica-de-retry.md) | Balanceamento com Nginx e retry apenas em operações idempotentes | Proposto |

## Formato

Cada arquivo segue a estrutura: **Contexto** → **Decisão** → **Alternativas consideradas** → **Consequências** (o que ganhamos e o que aceitamos perder).

Status possíveis: *Proposto* (em revisão pelo grupo), *Aceito*, *Substituído por ADR-XXXX*.

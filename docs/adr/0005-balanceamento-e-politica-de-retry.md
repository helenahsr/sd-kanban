# ADR 0005: Balanceamento com Nginx e retry apenas em operações idempotentes

**Status:** Aceito
**Data:** 2026-10-18

## Contexto

O trabalho exige pelo menos um serviço com 2 ou mais réplicas atrás de um balanceador, e timeouts e retry com backoff em toda chamada remota. A api-gateway roda com 2 réplicas, e precisamos decidir:

1. **qual balanceador** usar e como ele descobre as réplicas;
2. **quem pode repetir uma requisição** que falhou. Repetir um `POST /tasks` que na verdade chegou a ser executado cria a tarefa duas vezes.

## Decisão

**Balanceador: Nginx (contêiner `load-balancer`), em round-robin.**
* O upstream `api-gateway:4000` usa `resolve` com o DNS interno do Docker (`resolver 127.0.0.11 valid=2s`). Réplicas que sobem ou caem entram e saem do balanceamento em até ~2 s, sem reiniciar o Nginx, e `docker compose up --scale api-gateway=N` funciona sem mudar configuração.
* **Failover:** `proxy_next_upstream error timeout http_502 http_503`, com `proxy_connect_timeout 1s` e até 3 tentativas. Uma réplica morta é detectada em ~1 s e a requisição vai para outra.
* O Nginx **não repete métodos não idempotentes** (POST) por padrão, e mantivemos esse comportamento.
* Faz o upgrade HTTP → WebSocket e usa `proxy_read_timeout 60s`, maior que o ping do Socket.io (25 s).
* Gera o `X-Correlation-Id` (`$request_id`) quando o cliente não envia um.

**Política de retry (em todas as camadas):**

| Chamada | Timeout | Retry |
|---|---|---|
| Navegador → API (`fetch`) | 8 s | GET/PUT/DELETE: 2 novas tentativas (300 ms, 600 ms) em erro de rede ou 5xx. **POST: nenhuma.** |
| Load-balancer → réplica | conexão 1 s | Outra réplica, exceto POST |
| API → MySQL | 5 s por query | Leituras e `UPDATE` com valores fixos: 2 novas tentativas, só em erro de conexão. **`INSERT`: nenhuma.** |
| API → RabbitMQ (publish) | 5 s para a confirmação | 2 novas tentativas. Pode duplicar a mensagem, mas o worker é idempotente ([ADR 0004](0004-consistencia-eventual-e-idempotencia.md)). |
| API/worker → conexão com RabbitMQ e MySQL | 5 s | Sem limite, backoff exponencial de 1 s a 15 s com *jitter* |

O backoff usa *jitter* (atraso aleatório entre 50% e 100% do valor exponencial) para que as réplicas não tentem reconectar todas no mesmo instante depois de uma queda.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| **Traefik** | Descobre serviços pelos labels do Docker de forma automática e tem painel. Seria uma boa escolha, mas o Nginx já era usado no frontend e o grupo já conhecia a configuração. A funcionalidade necessária é a mesma. |
| **Kubernetes Service** | Exigiria rodar um cluster (kind/minikube) na máquina do laboratório. O enunciado pede `docker compose up`. |
| **DNS round-robin do Docker, sem balanceador** | O cliente resolve o nome uma vez e fica preso a uma réplica, sem failover nem health check. Além disso, o navegador não está na rede do Docker. |
| **Nginx com upstream estático** (sem `resolve`) | O IP das réplicas é resolvido só na inicialização. Se uma réplica for recriada com outro IP, ela nunca mais recebe tráfego. |
| **Retry em tudo, inclusive POST** | Duplicaria tarefas quando a primeira tentativa foi executada mas a resposta se perdeu. Resolver isso exigiria uma chave de idempotência no POST, o que não justificava a complexidade aqui. |

## Consequências

**Positivas**
* Derrubando uma réplica durante tráfego contínuo: **0 erros em 177 requisições** (roteiro de falha, cenário 1).
* No teste de carga, as duas réplicas receberam carga equivalente (~25% de CPU cada).
* Retry só onde é seguro: nenhuma tarefa duplicada por repetição.

**Negativas / aceitas**
* **O balanceador é um ponto único de falha.** Se o `load-balancer` cair, o sistema fica inacessível, mesmo com as réplicas da API saudáveis. Em produção, seriam dois balanceadores com IP flutuante (keepalived) ou um balanceador gerenciado de nuvem.
* **Janela de detecção:** na primeira versão (timeout de 2 s e DNS a cada 5 s), uma requisição em ~160 recebeu 504 no momento exato da queda. Reduzimos os tempos e o problema não se repetiu, mas a janela não é zero. O retry do frontend cobre o GET/PUT/DELETE, mas um **POST nesse instante falha** e o usuário precisa tentar de novo (vê uma mensagem de erro).
* O health check usado pelo Nginx é **passivo** (marca a réplica como falha depois de um erro real). Health check ativo exige o Nginx Plus ou outro balanceador. O `/health` de cada réplica é usado pelo Docker (healthcheck do compose), não pelo Nginx.

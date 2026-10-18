# ADR 0002: Um banco por serviço

**Status:** Proposto
**Data:** 2026-10-18

## Contexto

Na primeira versão, a API e o worker usavam o **mesmo** MySQL: a API gravava as tarefas e o worker gravava o histórico numa tabela com chave estrangeira para `card`. Isso criava um acoplamento escondido:

* uma mudança no schema da API podia quebrar o worker;
* se o MySQL caísse, os dois serviços caíam juntos;
* o worker podia ler e alterar tarefas diretamente, sem passar pela API;
* o trabalho pede que cada serviço tenha banco ou estado próprio, quando fizer sentido.

## Decisão

Cada serviço com estado tem **seu próprio banco, em contêiner separado**:

* **`database`** (MySQL): pertence à **api-gateway**. Tabelas `status` e `card`, criadas pelo [`database/init.sql`](../../database/init.sql).
* **`history-db`** (MySQL): pertence ao **worker**. Tabela `historico`, criada pelo próprio worker ao subir (`CREATE TABLE IF NOT EXISTS`).

O único caminho de dados entre os dois serviços é o **evento no RabbitMQ**. O worker não conhece o banco da API e o histórico não tem chave estrangeira para `card`: ele guarda só o `task_id`.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| **Banco compartilhado** (situação anterior) | Pelos motivos do contexto: acoplamento de schema e de disponibilidade. |
| **Mesmo servidor MySQL, schemas separados** | Usa menos memória (~400 MB a menos), mas mantém um ponto único de falha e exigiria um script de init com permissões por schema. Isola o schema, mas não a falha. |
| **Worker sem banco** (só logar o evento) | Não haveria estado para demonstrar idempotência nem integridade: não daria para provar "processou exatamente uma vez cada evento". |
| **Outro tipo de banco para o histórico** (MongoDB, Postgres) | Faria sentido para um log de eventos (documentos JSON), mas o MySQL 8 já tem a coluna `JSON` e o grupo já domina a ferramenta. Usar a mesma imagem também simplifica o compose. |

## Consequências

**Positivas**
* Os serviços evoluem e falham de forma independente. Com o `history-db` fora do ar, o quadro continua funcionando e os eventos esperam na fila.
* O dono de cada dado é explícito: tarefa é da API, histórico é do worker.
* A chave primária `event_id` no banco do worker é o que garante a idempotência ([ADR 0004](0004-consistencia-eventual-e-idempotencia.md)).

**Negativas / aceitas**
* **+~400 MB de RAM** por causa do segundo MySQL (medido no teste de carga: 393 MB).
* **Sem JOIN entre tarefas e histórico.** Para mostrar "histórico da tarefa X com o título atual", seria preciso combinar os dados na aplicação, ou o worker guardar uma cópia dos campos necessários (o evento já carrega o estado da tarefa em `task`).
* **Dados duplicados e eventualmente consistentes:** o histórico pode mencionar uma tarefa já excluída (soft delete) ou estar atrasado.
* Duas bases para fazer backup e inicializar (`docker compose down -v` apaga as duas).

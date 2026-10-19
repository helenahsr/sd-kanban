SET NAMES utf8mb4;

USE kanban;

CREATE TABLE status (
    id INT AUTO_INCREMENT PRIMARY KEY,
    codigo VARCHAR(20) NOT NULL UNIQUE,
    nome VARCHAR(50) NOT NULL,
    is_ativo BOOLEAN NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE card (
    id INT AUTO_INCREMENT PRIMARY KEY,
    titulo VARCHAR(255) NOT NULL,
    relator VARCHAR(100) NOT NULL,
    responsavel VARCHAR(100) NOT NULL,
    prioridade ENUM('alta', 'media', 'baixa') NOT NULL DEFAULT 'media',
    fk_id_status INT NOT NULL,
    inserted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL DEFAULT NULL,
    FOREIGN KEY (fk_id_status) REFERENCES status(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- O histórico de eventos fica no banco próprio do worker (serviço history-db)

INSERT INTO status (codigo, nome) VALUES
    ('todo', 'Tarefas Pendentes'),
    ('doing', 'Em Andamento'),
    ('done', 'Concluído');

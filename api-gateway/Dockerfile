# Usa uma imagem leve do Node.js
FROM node:20-alpine

# Define o diretório de trabalho dentro do container
WORKDIR /usr/src/app

# Copia os arquivos de dependências primeiro (otimiza o cache de build do Docker)
COPY package*.json ./

# Instala as dependências
RUN npm install --omit=dev

# Copia o restante do código do projeto para o container
COPY . .

# Expõe a porta da aplicação
EXPOSE 4000

# Comando padrão para iniciar a aplicação
# node direto (e não npm start) para receber o SIGTERM do `docker stop` e encerrar limpo
CMD ["node", "src/index.js"]
# Usa uma imagem leve do Node.js
FROM node:18-alpine

# Define o diretório de trabalho dentro do container
WORKDIR /usr/src/app

# Copia os arquivos de dependências primeiro (otimiza o cache de build do Docker)
COPY package*.json ./

# Instala as dependências
RUN npm install

# Copia o restante do código do projeto para o container
COPY . .

# Expõe a porta da aplicação (no worker, você pode omitir essa linha)
EXPOSE 4000

# Comando padrão para iniciar a aplicação
CMD ["npm", "start"]
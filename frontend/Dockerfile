FROM node:18-alpine
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
# Comando típico para rodar um servidor de desenvolvimento (React/Next/Vite)
CMD ["npm", "run", "dev"]
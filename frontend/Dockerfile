# Servidor web leve para os arquivos estáticos (HTML/CSS/JS puro)
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY src/ /usr/share/nginx/html/

EXPOSE 80

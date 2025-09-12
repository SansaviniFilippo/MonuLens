FROM nginx:1.27-alpine

# Copia i contenuti del frontend nella radice HTML
# Risultato: /usr/share/nginx/html/public, /usr/share/nginx/html/src, ...
COPY frontend /usr/share/nginx/html

# Configurazione Nginx personalizzata
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
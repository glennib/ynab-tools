FROM docker.io/nginxinc/nginx-unprivileged:1.30.6-alpine

# The OAuth client ID is injected at runtime; nginx serves it as /config.js.
# It must be defined, even if empty, for the template to substitute it.
ENV YNAB_CLIENT_ID=""

COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY nginx/headers.conf /etc/nginx/snippets/headers.conf
COPY index.html personvern.html privacy.html app.js convert.js ynab.js style.css \
     favicon.svg favicon.ico apple-touch-icon.png /usr/share/nginx/html/

EXPOSE 8080

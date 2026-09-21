# Orihime MD + WAHA GOWS in one Render web service.
# All Orihime source files are stored at the repository root.
FROM devlikeapro/waha:gows-2026.8.2

WORKDIR /orihime

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .
RUN chmod +x /orihime/render-entrypoint.sh

ENV WHATSAPP_DEFAULT_ENGINE=GOWS \
    WHATSAPP_API_PORT=3000 \
    WHATSAPP_API_HOSTNAME=127.0.0.1 \
    WAHA_LOCAL_STORE_BASE_DIR=/app/.sessions \
    WHATSAPP_FILES_FOLDER=/app/.media \
    WHATSAPP_FILES_LIFETIME=0 \
    WAHA_PRINT_QR=false \
    WAHA_WORKER_RESTART_SESSIONS=true \
    WAHA_DASHBOARD_ENABLED=false \
    WHATSAPP_SWAGGER_ENABLED=false

EXPOSE 10000

CMD ["/orihime/render-entrypoint.sh"]

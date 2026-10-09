FROM node:24.21.0-bookworm-slim
WORKDIR /app
COPY signal/package.json signal/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY signal/server.mjs signal/start.mjs ./signal/
COPY local/network/identity.mjs ./local/network/identity.mjs
USER node
ENV SIGNAL_HOST=0.0.0.0 SIGNAL_PORT=8443 SIGNAL_TLS_CERT=/certificates/server-cert.pem SIGNAL_TLS_KEY=/certificates/server-key.pem
EXPOSE 8443/tcp
CMD ["node", "signal/start.mjs"]

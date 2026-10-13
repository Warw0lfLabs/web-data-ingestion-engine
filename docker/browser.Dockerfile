FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY docker/browser-server.mjs ./server.mjs
USER pwuser
CMD ["node", "server.mjs"]

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY config ./config
COPY docker/worker-health.mjs ./docker/worker-health.mjs
USER node
CMD ["node", "dist/entrypoints/api.js"]

FROM api AS worker
CMD ["node", "dist/entrypoints/worker.js"]

FROM api AS fixtures
COPY tests/fixtures ./tests/fixtures
CMD ["node", "dist/entrypoints/fixtures.js"]

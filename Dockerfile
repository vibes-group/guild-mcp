# Нативный better-sqlite3 компилится в этом стейдже (нужны build-tools).
FROM node:24-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Рантайм slim без build-tools — нативный модуль уже собран на той же базе.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Рантайм — под non-root; свежий том наследует ownership этого каталога.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
CMD ["node", "dist/index.js"]

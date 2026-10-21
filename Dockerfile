# One image, two processes:
#   API:    docker run aiainai-backend                      (node dist/main.js, port 4000)
#   Worker: docker run aiainai-backend node dist/worker.js   (port 4001)
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production PORT=4000 WORKER_PORT=4001
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/package.json ./
USER app
EXPOSE 4000 4001
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1
CMD ["node", "dist/main.js"]

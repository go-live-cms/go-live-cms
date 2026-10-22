FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=1234
# LevelDB lives here; compose mounts a named volume on it. Created below and owned
# by `node`, so a fresh volume inherits that ownership and the non-root user can write.
ENV DATA_PATH=/data/yjs

# Lockfile install (exact yjs/y-websocket pins, see CLAUDE.md), no dev deps.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# server.js imports access.js, upgrade.js, logsafe.js and persistence.js, so copy
# every module; the *.test.js files are harmless but not needed.
COPY *.js ./
RUN rm -f ./*.test.js

RUN mkdir -p /data/yjs && chown -R node:node /data
USER node

EXPOSE 1234

# The healthcheck lives in compose.yaml, like the api's and web's.
CMD ["node", "server.js"]

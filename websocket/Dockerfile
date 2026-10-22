FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production

# Lockfile install (exact yjs/y-websocket pins, see CLAUDE.md), no dev deps.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# server.js imports access.js, upgrade.js, logsafe.js and persistence.js, so copy
# every module; the *.test.js files are harmless but not needed.
COPY *.js ./
RUN rm -f ./*.test.js

EXPOSE 1234

CMD ["node", "server.js"]

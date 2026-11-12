# The Hocuspocus collab server (#206). Build context: web/ (it shares web's lockfile and
# imports the editor's schema and Block Spec bridge from gl-admin/):
#   docker build -f web/collab-server/Dockerfile web
#
# The runtime stage holds ONE file, the esbuild bundle, and no node_modules: nothing can
# require() a second copy of yjs (collab-server/CLAUDE.md, "Single yjs instance").
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
# No install scripts: the bundle needs none (esbuild's binary comes from its
# platform package), and this skips sharp/leveldown builds the server never uses.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY collab-server ./collab-server
COPY gl-admin ./gl-admin
# The installed themes' block definitions (themes/*/blocks/*/index.ts, #376) are bundled;
# adding or changing a theme block means rebuilding this image.
COPY themes ./themes
# The plugins' plugin.json and block.json (#456): data only, never a plugin's code (build.mjs
# fails on any other plugin file in the bundle). Installing, upgrading or removing a plugin
# with blocks means rebuilding this image.
COPY plugins ./plugins
RUN node collab-server/build.mjs /out/server.mjs

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=1235
ENV INTERNAL_PORT=1236
COPY --from=build /out/server.mjs /out/server.mjs.map ./
USER node
# 1235: WebSocket (behind the proxy). 1236: internal (/healthz, flush); never publish it.
EXPOSE 1235
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1:${INTERNAL_PORT}/healthz >/dev/null || exit 1
CMD ["node", "--enable-source-maps", "server.mjs"]

FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# The editor's collab backend, inlined at build (gl-admin/lib/collaboration/backend.ts).
# Must match the API's COLLAB_BACKEND. Hocuspocus since the P4 cutover (#284); build
# with --build-arg PUBLIC_COLLAB_BACKEND=y-websocket only to roll back
# (docs/operations/collab-cutover.md).
ARG PUBLIC_COLLAB_BACKEND=hocuspocus
ENV PUBLIC_COLLAB_BACKEND=$PUBLIC_COLLAB_BACKEND
RUN npm run build
# Keep only the runtime dependencies for the final stage (no second install).
RUN npm prune --omit=dev

# The site is SSR (output: "server"), so it runs the standalone Node server the
# @astrojs/node adapter emits, not a static file server.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# The middleware serves /themes/* from process.cwd()/themes at request time.
COPY --from=builder /app/themes ./themes
USER node
EXPOSE 4321
CMD ["node", "./dist/server/entry.mjs"]

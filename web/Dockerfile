FROM node:22-alpine AS builder
WORKDIR /app

# PUBLIC_* vars are inlined into the client bundle at build time.
ARG PUBLIC_API_URL
ENV PUBLIC_API_URL=$PUBLIC_API_URL

COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The SSR server (@astrojs/node standalone) serves dist/client itself.
COPY --from=builder /app/dist ./dist
# The middleware serves /themes/* from process.cwd() at runtime.
COPY --from=builder /app/themes ./themes

USER node
EXPOSE 4321
CMD ["node", "dist/server/entry.mjs"]

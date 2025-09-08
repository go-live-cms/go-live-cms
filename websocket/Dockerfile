FROM node:24-alpine

WORKDIR /app

RUN npm init -y && \
    npm install y-websocket ws

COPY server.js .

EXPOSE 1234

CMD ["node", "server.js"]
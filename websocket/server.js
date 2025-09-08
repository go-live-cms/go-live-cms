const { WebSocketServer } = require("ws");
const { setupWSConnection } = require("y-websocket/bin/utils");

const HOST = process.env.HOST || "localhost";
const PORT = process.env.PORT || 1234;

const wss = new WebSocketServer({
  host: HOST,
  port: PORT,
});

wss.on("connection", (ws, req) => {
  console.log("New WebSocket connection:", req.url);
  setupWSConnection(ws, req);
});

console.log(`Yjs WebSocket server running on ws://${HOST}:${PORT}`);

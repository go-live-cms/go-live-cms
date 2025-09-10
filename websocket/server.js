import { WebSocketServer } from "ws";
import { setupWSConnection } from "y-websocket/bin/utils";
import { URL } from "url";

const HOST = process.env.HOST || "localhost";
const PORT = process.env.PORT || 1234;

const wss = new WebSocketServer({
  host: HOST,
  port: PORT,
});

wss.on("connection", (ws, req) => {
  console.log("New WebSocket connection:", req.url);

  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token");

  if (token) {
    console.log("Connection has token:", token.substring(0, 20) + "...");
  } else {
    console.log("Connection has no token");
  }

  setupWSConnection(ws, req, {
    token: token,
  });
});

console.log(`Yjs WebSocket server running on ws://${HOST}:${PORT}`);

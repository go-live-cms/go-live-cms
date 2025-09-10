import { WebSocketServer } from "ws";
import { setupWSConnection } from "y-websocket/bin/utils";
import { URL } from "url";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 1234);

// Go API endpoint for ticket verification
const GO_API_URL = process.env.GO_API_URL || "http://localhost:8080/api/v1";

const wss = new WebSocketServer({ host: HOST, port: PORT });

wss.on("connection", async (ws, req) => {
  try {
    console.log("New WebSocket connection attempt:", req.url);

    // Parse URL and extract ticket + room
    const url = new URL(req.url, `ws://${req.headers.host}`);
    const ticket = url.searchParams.get("ticket") || "";
    // y-websocket uses the pathname as the "room"/doc name; e.g. /post-123
    const room = url.pathname.replace(/^\/+/, "") || "default";

    console.log(`Connection to room: ${room}`);

    if (!ticket) {
      console.log("❌ No ticket provided");
      ws.close(4401, "Unauthorized: No ticket provided");
      return;
    }

    // Verify ticket with Go backend
    let userData;
    try {
      console.log(`🔍 Verifying ticket with Go API...`);

      const verifyResponse = await fetch(`${GO_API_URL}/ws/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ticket: ticket,
          room: room,
        }),
      });

      if (!verifyResponse.ok) {
        const errorData = await verifyResponse.json().catch(() => ({}));
        console.log(
          "❌ Ticket verification failed:",
          verifyResponse.status,
          errorData.error || "Unknown error"
        );
        ws.close(4401, "Unauthorized: Invalid ticket");
        return;
      }

      userData = await verifyResponse.json();
      console.log(
        `✅ Ticket verified for user ID: ${userData.user_id}, post ID: ${userData.post_id}`
      );
    } catch (err) {
      console.log("❌ Ticket verification request failed:", err.message);
      ws.close(4401, "Unauthorized: Verification failed");
      return;
    }

    console.log(`✅ User ${userData.user_id} authorized for room: ${room}`);

    // Attach user info to request for potential use in y-websocket
    req.__user = {
      id: userData.user_id,
      postId: userData.post_id,
    };

    // Hand off to y-websocket ONLY AFTER auth passes
    setupWSConnection(ws, req, {
      // Enable garbage collection
      gc: true,
    });
  } catch (err) {
    console.error("❌ WebSocket connection error:", err);
    // Hide details from client; just refuse connection
    try {
      ws.close(4401, "Unauthorized");
    } catch (closeErr) {
      console.error("Error closing WebSocket:", closeErr);
    }
  }
});

// Handle server-level errors
wss.on("error", (err) => {
  console.error("WebSocket server error:", err);
});

console.log(`🚀 Yjs WebSocket server running on ws://${HOST}:${PORT}`);
console.log(`🎫 Using ticket-based authentication with Go API: ${GO_API_URL}`);
console.log(`📝 Room format: /post-{id} or /default`);

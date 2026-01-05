import "dotenv/config";
import { WebSocketServer } from "ws";
import { setupWSConnection } from "y-websocket/bin/utils";
import { URL } from "url";
import { V4 } from "paseto";
import { createPublicKey } from "crypto";
import http from "http";
import fs from "fs";

const HOST = process.env.HOST || "localhost";
const PORT = Number(process.env.PORT) || 1234;
const ISSUER = process.env.PASETO_ISSUER || "go-live-cms";
const AUDIENCE = process.env.PASETO_AUDIENCE || "go-live-cms-ws";
const ALLOWED_AUDIENCES = process.env.PASETO_ALLOWED_AUDIENCES?.split(",") || [
  AUDIENCE,
];

console.log("🔍 Environment debug:");
console.log("   - process.env.HOST:", process.env.HOST);
console.log("   - Resolved HOST:", HOST);
console.log(
  "   - process.env.PASETO_ALLOWED_AUDIENCES:",
  process.env.PASETO_ALLOWED_AUDIENCES
);

// Flexible public key loading (supports PEM, base64, or file)
function loadPublicKey() {
  const pem = process.env.PASETO_V4_PUBLIC_PEM;
  const pemB64 = process.env.PASETO_V4_PUBLIC_PEM_B64;
  const pemFile = process.env.PASETO_V4_PUBLIC_PEM_FILE;

  if (pem && pem.trim()) {
    console.log("📋 Loading public key from PASETO_V4_PUBLIC_PEM");
    return createPublicKey(pem);
  }
  if (pemB64 && pemB64.trim()) {
    console.log("📋 Loading public key from PASETO_V4_PUBLIC_PEM_B64");
    return createPublicKey(Buffer.from(pemB64, "base64").toString("utf8"));
  }
  if (pemFile && fs.existsSync(pemFile)) {
    console.log("📋 Loading public key from file:", pemFile);
    return createPublicKey(fs.readFileSync(pemFile, "utf8"));
  }

  console.error(
    "❌ Provide PASETO_V4_PUBLIC_PEM, PASETO_V4_PUBLIC_PEM_B64, or PASETO_V4_PUBLIC_PEM_FILE"
  );
  process.exit(1);
}

let PUBLIC_KEY;
try {
  PUBLIC_KEY = loadPublicKey();
  console.log("✅ PASETO v4.public key loaded successfully");
  console.log("🎯 Configuration:");
  console.log("   - Host:", HOST);
  console.log("   - Port:", PORT);
  console.log("   - Issuer:", ISSUER);
  console.log("   - Primary Audience:", AUDIENCE);
  console.log("   - Allowed Audiences:", ALLOWED_AUDIENCES.join(", "));
} catch (error) {
  console.error("❌ Failed to load PASETO v4.public key:", error.message);
  process.exit(1);
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("GoLive WebSocket server is running");
});

const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws, req) => {
  console.log(
    "✅ WebSocket connection established for user:",
    req.auth?.username || "unknown"
  );

  // Keep connection alive to prevent idle disconnects behind proxies
  const keepAliveInterval = setInterval(() => {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      }
    } catch (error) {
      // Ignore ping errors
    }
  }, 25000); // 25 seconds

  ws.on("close", () => {
    clearInterval(keepAliveInterval);
  });

  setupWSConnection(ws, req);
});

server.on("upgrade", async (req, socket, head) => {
  console.log("📡 WebSocket upgrade request:", req.url);
  try {
    console.log("🔗 WebSocket upgrade request");
    console.log("📍 URL:", req.url);
    console.log("🔍 Headers:", JSON.stringify(req.headers, null, 2));

    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    console.log("🎯 Parsed URL params:", Object.fromEntries(url.searchParams));
    const credential =
      url.searchParams.get("ticket") || url.searchParams.get("token");
    if (!credential) {
      console.error("🚫 No ticket or token provided");
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\n\r\nNo authentication credentials provided\r\n"
      );
      socket.destroy();
      return;
    }
    console.log("🔑 Verifying PASETO v4.public credential...");
    if (process.env.NODE_ENV !== "production") {
      console.log("🔍 Token preview:", credential.substring(0, 50) + "...");
    }
    console.log("🎯 Trying audiences:", ALLOWED_AUDIENCES.join(", "));

    let tokenValid = false;
    let payload, footer;

    for (const aud of ALLOWED_AUDIENCES) {
      try {
        const result = await V4.verify(credential, PUBLIC_KEY, {
          issuer: ISSUER,
          audience: aud.trim(),
          clockTolerance: "60s",
          complete: true,
        });
        payload = result.payload;
        footer = result.footer;
        tokenValid = true;
        console.log(`✅ Token verified successfully for audience: ${aud}`);
        break;
      } catch (err) {
        continue;
      }
    }

    if (!tokenValid) {
      throw new Error(
        `Token invalid for any allowed audience: ${ALLOWED_AUDIENCES.join(
          ", "
        )}`
      );
    }
    console.log("✅ Token verified successfully for user:", payload.sub);
    console.log("👤 User roles:", payload.roles || "none");
    req.auth = {
      sub: payload.sub,
      username: payload.username,
      roles: payload.roles || [],
      kid: footer?.kid,
      tokenPayload: payload,
    };
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } catch (error) {
    console.error("🚫 WebSocket authentication failed:", error.message);
    socket.write(
      "HTTP/1.1 401 Unauthorized\r\n\r\nInvalid or expired authentication credentials\r\n"
    );
    socket.destroy();
  }
});

server.on("error", (error) => {
  console.error("❌ HTTP server error:", error);
});

server.listen(PORT, HOST, () => {
  console.log(
    `🔌 Yjs WebSocket server with PASETO v4.public auth running on ws://${HOST}:${PORT}`
  );
  console.log(
    `🔒 Expecting ?ticket=<v4.public> or ?token=<v4.public> (issuer=${ISSUER})`
  );
  console.log(`🎯 Allowed audiences: ${ALLOWED_AUDIENCES.join(", ")}`);
  console.log("🛡️ Authentication happens during HTTP upgrade - no 4401 loops!");
});

// Graceful shutdown for hot reload
function shutdown() {
  console.log("🔻 Shutting down WebSocket server...");
  try {
    wss.clients?.forEach((client) => {
      if (client.readyState === 1) {
        client.close(1001, "Server restart");
      }
    });
  } catch (err) {
    console.error("Error closing WebSocket clients:", err.message);
  }

  try {
    wss.close();
  } catch (err) {
    console.error("Error closing WebSocket server:", err.message);
  }

  try {
    server.close(() => {
      console.log("✅ Server shutdown complete");
      process.exit(0);
    });
  } catch (err) {
    console.error("Error closing HTTP server:", err.message);
    process.exit(0);
  }
}

// Handle shutdown signals
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// nodemon restarts with SIGUSR2
process.once("SIGUSR2", () => {
  console.log("🔄 Hot reload triggered...");
  shutdown();
  setTimeout(() => process.kill(process.pid, "SIGUSR2"), 250);
});

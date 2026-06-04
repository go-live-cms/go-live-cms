import "dotenv/config";
import { WebSocketServer } from "ws";
import { setupWSConnection, setPersistence } from "y-websocket/bin/utils";
import { LeveldbPersistence } from "y-leveldb";
import * as Y from "yjs";
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
const DATA_PATH = (process.env.DATA_PATH || "./data").trim();
const SQUASH_SECRET = (process.env.SQUASH_SECRET || "").trim();

console.log("🔍 Environment debug:");
console.log("   - process.env.HOST:", process.env.HOST);
console.log("   - Resolved HOST:", HOST);
console.log(
  "   - process.env.PASETO_ALLOWED_AUDIENCES:",
  process.env.PASETO_ALLOWED_AUDIENCES,
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
    "❌ Provide PASETO_V4_PUBLIC_PEM, PASETO_V4_PUBLIC_PEM_B64, or PASETO_V4_PUBLIC_PEM_FILE",
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
  console.log("   - DATA_PATH:", DATA_PATH);
  console.log(
    "   - Squash endpoint:",
    SQUASH_SECRET ? "enabled" : "DISABLED (no SQUASH_SECRET set)",
  );
} catch (error) {
  console.error("❌ Failed to load PASETO v4.public key:", error.message);
  process.exit(1);
}

// PERSISTENCE BACKEND: y-leveldb (single-node, file-based).
// To swap for y-redis (see issue #186), replace the ldb initialisation and
// setPersistence callbacks below with y-redis equivalents.
// See: https://github.com/yjs/y-redis
const ldb = new LeveldbPersistence(DATA_PATH);
console.log("💾 LevelDB persistence initialised at:", DATA_PATH);

setPersistence({
  bindState: async (docName, ydoc) => {
    // Register the update listener FIRST — before the async LevelDB read — so no
    // client update that arrives during the IO round-trip is lost. A lost update
    // would leave a GAP in the stored log (update N+1 without N), and every future
    // getYDoc for this doc would then fail to integrate that gap and crash sync.
    ydoc.on("update", (update) => {
      try {
        ldb.storeUpdate(docName, update);
      } catch (err) {
        console.error(`⚠️  Failed to persist update for ${docName}:`, err.message);
      }
    });

    // The LevelDB layer is only a SAFETY NET — the canonical document lives in
    // Postgres (posts.block_doc) via the API autosave. A corrupt or gapped safety
    // net must NEVER break live collaboration, so we validate the stored state in a
    // throwaway doc before merging it into the live ydoc, and skip it on any problem.
    try {
      const persistedYdoc = await ldb.getYDoc(docName);
      const update = Y.encodeStateAsUpdate(persistedYdoc);

      // Probe: apply to a disposable doc. Gapped updates (missing dependencies)
      // leave un-integrated "pending" structs. Applying such a doc to the live
      // ydoc would poison it and crash on the next client message — detect & skip.
      const probe = new Y.Doc();
      Y.applyUpdate(probe, update);
      const hasPending =
        probe.store?.pendingStructs != null ||
        (probe.store?.pendingClientsStructRefs?.size ?? 0) > 0;
      probe.destroy();

      if (hasPending) {
        console.warn(
          `⚠️  Persisted state for ${docName} is incomplete/corrupt — skipping it. ` +
            `The Postgres working copy is canonical; the safety net will rebuild from live edits.`
        );
        return;
      }

      // Safe to merge. Yjs CRDT merges are additive, so live client content is
      // never overwritten by older/empty persisted state.
      Y.applyUpdate(ydoc, update);
    } catch (err) {
      console.error(
        `⚠️  Failed to load persisted state for ${docName} — continuing without it:`,
        err.message
      );
    }
  },
  writeState: async (_docName, _ydoc) => {
    // No-op: updates are written incrementally in the bindState update listener.
    // writeState fires when the last client disconnects; nothing extra needed here.
  },
});

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("GoLive WebSocket server is running");
    return;
  }

  // Internal squash endpoint — merges all LevelDB update entries for a document
  // into a single snapshot. Called by the Go API after a post is published.
  // TODO: bind internal endpoints to a separate port if WS port becomes internet-facing.
  const squashMatch = req.url?.match(/^\/_internal\/documents\/(.+)\/squash$/);
  if (req.method === "POST" && squashMatch) {
    const auth = req.headers["authorization"] || "";
    if (!SQUASH_SECRET || auth !== `Bearer ${SQUASH_SECRET}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const docName = decodeURIComponent(squashMatch[1]);
    console.log(`🗜️  Squash requested for document: ${docName}`);
    try {
      await ldb.flushDocument(docName);
      console.log(`✅ Squash complete for: ${docName}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, docName }));
    } catch (err) {
      console.error(`❌ Squash failed for ${docName}:`, err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "squash failed", detail: err.message }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws, req) => {
  console.log(
    "✅ WebSocket connection established for user:",
    req.auth?.username || "unknown",
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
        "HTTP/1.1 401 Unauthorized\r\n\r\nNo authentication credentials provided\r\n",
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
          ", ",
        )}`,
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
      "HTTP/1.1 401 Unauthorized\r\n\r\nInvalid or expired authentication credentials\r\n",
    );
    socket.destroy();
  }
});

server.on("error", (error) => {
  console.error("❌ HTTP server error:", error);
});

server.listen(PORT, HOST, () => {
  console.log(
    `🔌 Yjs WebSocket server with PASETO v4.public auth running on ws://${HOST}:${PORT}`,
  );
  console.log(
    `🔒 Expecting ?ticket=<v4.public> or ?token=<v4.public> (issuer=${ISSUER})`,
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
    server.close(async () => {
      // LevelDB is crash-safe; incomplete writes on hot-reload are recovered on next open.
      try {
        await ldb.destroy();
        console.log("💾 LevelDB closed cleanly");
      } catch (err) {
        console.error("Warning: LevelDB close error:", err.message);
      }
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

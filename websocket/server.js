import "dotenv/config";
import { WebSocketServer } from "ws";
import { createRequire } from "node:module";
import { evaluatePersistedState } from "./persistence.js";
import {
  fetchCurrentRole,
  isCollabDocName,
  TicketReplayGuard,
  publicKeyFromHex,
  verifyTicket,
  TICKET_AUDIENCE,
} from "./access.js";
import { createUpgradeHandler, docNameFromReq } from "./upgrade.js";
import { logEvent, requestIdFrom } from "./logsafe.js";
import { createPublicKey } from "crypto";
import http from "http";
import fs from "fs";

// CRITICAL — single-yjs-instance rule (the root cause of the editor data-loss bugs):
// yjs and y-leveldb ship BOTH ESM and CJS builds. y-websocket's server utils
// (bin/utils.cjs) are CJS, so their require("yjs") loads dist/yjs.cjs. An ESM
// `import * as Y from "yjs"` here loads dist/yjs.mjs — the SAME package evaluated a
// SECOND time, with a separate class registry. Yjs itself warns at startup:
//   "Yjs was already imported. This breaks constructor checks and will lead to
//    issues!" (https://github.com/yjs/yjs/issues/438)
// The damage: bindState's Y.applyUpdate (ESM build) onto the WSSharedDoc (CJS build)
// fails yjs's internal constructor checks and silently mis-integrates, structurally
// corrupting the live doc. Symptom: the doc "wedges" — it stops integrating a client's
// updates (structural edits like Enter-splits / paragraph→heading trigger it), and the
// 2s resync then resets that client's editor to the wedged state, erasing typed content.
// So: load yjs / y-leveldb / bin/utils through createRequire so this whole process
// shares the single CJS instance. The startup probe below hard-fails on regression.
const require = createRequire(import.meta.url);
const { setupWSConnection, setPersistence, docs, getYDoc } = require("y-websocket/bin/utils");
const { LeveldbPersistence } = require("y-leveldb");
const Y = require("yjs");

// Fail fast if two yjs builds are ever loaded again (e.g. someone reverts the requires
// above to ESM imports). A doc created by y-websocket's utils must be an instance of OUR
// Y.Doc — if not, every cross-instance call corrupts documents, which is far worse than
// a server that refuses to boot. Runs before setPersistence so bindState isn't invoked.
{
  const probe = getYDoc("__yjs-instance-probe__");
  const sameInstance = probe instanceof Y.Doc;
  probe.destroy();
  docs.delete("__yjs-instance-probe__");
  if (!sameInstance) {
    console.error(
      "❌ FATAL: two yjs instances are loaded (ESM/CJS dual import). " +
        "All yjs-family packages must resolve to the same build — see the comment above this check.",
    );
    process.exit(1);
  }
}

const HOST = process.env.HOST || "localhost";
const PORT = Number(process.env.PORT) || 1234;
// Same default as the API's PASETO_ISSUER (util/config.go), so the two agree unset.
const ISSUER = process.env.PASETO_ISSUER || "golive.auth";
// Trim first, THEN fall back to "./data", so DATA_PATH=" " (whitespace only)
// resolves to "./data" rather than "" (which would silently use the CWD).
const DATA_PATH = (process.env.DATA_PATH || "").trim() || "./data";
const SQUASH_SECRET = (process.env.SQUASH_SECRET || "").trim();
// Base URL of the Go API's INTERNAL listener (e.g. http://api:8081 — a separate,
// unpublished port, not the public /api/v1). Every upgrade looks up the caller's current
// role at `${INTERNAL_API_URL}/internal/users/:id/role`, authenticated with
// ROLE_LOOKUP_SECRET (not the client's ticket); see access.js. Both are required —
// without them the server can't tell editors from contributors, so it refuses to start
// (fail closed).
const INTERNAL_API_URL = (process.env.INTERNAL_API_URL || "").trim();
if (!INTERNAL_API_URL) {
  console.error(
    "❌ INTERNAL_API_URL is required (e.g. http://api:8081, the API's internal listener) for the per-connection role check" +
      (process.env.API_URL ? " — API_URL is no longer used for this (#223)" : ""),
  );
  process.exit(1);
}
const ROLE_LOOKUP_SECRET = (process.env.ROLE_LOOKUP_SECRET || "").trim();
if (!ROLE_LOOKUP_SECRET) {
  console.error("❌ ROLE_LOOKUP_SECRET is required (must match ROLE_LOOKUP_SECRET in the Go API's config) for the per-connection role check");
  process.exit(1);
}

// Debug-gated logging (COLLAB_DEBUG=1) for diagnosing the WS-restart instability.
// Timestamped so it aligns with the browser's GL_DEBUG_COLLAB logs.
const COLLAB_DEBUG = (process.env.COLLAB_DEBUG || "").trim() === "1";
const collabDebug = (...args) => {
  if (COLLAB_DEBUG) console.debug(`[collab t=${Date.now()}]`, ...args);
};
// The editor binds the @tiptap/extension-collaboration document to the "default"
// XmlFragment (NOT "prosemirror"). Measuring "prosemirror" always returned 0, making
// every server-side length log meaningless during past diagnosis. Measure "default".
const docLen = (ydoc) => ydoc.getXmlFragment("default").length;


console.log("🔍 Environment debug:");
console.log("   - process.env.HOST:", process.env.HOST);
console.log("   - Resolved HOST:", HOST);
if (process.env.PASETO_AUDIENCE || process.env.PASETO_ALLOWED_AUDIENCES) {
  // Pre-#233 settings. Only collab tickets (audience golive.admin-ws) are accepted now;
  // access tokens never authenticate a socket, whatever these say.
  console.warn("⚠️  PASETO_AUDIENCE / PASETO_ALLOWED_AUDIENCES are ignored (tickets only, #233)");
}

// Flexible public key loading (supports the API's raw hex key, PEM, base64, or file)
function loadPublicKey() {
  const hex = process.env.PASETO_V4_PUBLIC_KEY_HEX;
  const pem = process.env.PASETO_V4_PUBLIC_PEM;
  const pemB64 = process.env.PASETO_V4_PUBLIC_PEM_B64;
  const pemFile = process.env.PASETO_V4_PUBLIC_PEM_FILE;

  if (hex && hex.trim()) {
    console.log("📋 Loading public key from PASETO_V4_PUBLIC_KEY_HEX");
    return publicKeyFromHex(hex);
  }
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
    "❌ Provide PASETO_V4_PUBLIC_KEY_HEX, PASETO_V4_PUBLIC_PEM, PASETO_V4_PUBLIC_PEM_B64, or PASETO_V4_PUBLIC_PEM_FILE",
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
  console.log("   - Ticket audience:", TICKET_AUDIENCE);
  console.log("   - DATA_PATH:", DATA_PATH);
  console.log("   - INTERNAL_API_URL (role lookup):", INTERNAL_API_URL);
  console.log("   - Role lookup: internal endpoint, shared secret (ROLE_LOOKUP_SECRET set)");
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

// Sentinel origin tagged on updates produced by our own restore step. We skip
// persistence for these (otherwise reconnects would re-write the full snapshot
// into LevelDB as a new entry on every connect, bloating the log).
const PERSISTENCE_ORIGIN = "leveldb-restore";

setPersistence({
  bindState: async (docName, ydoc) => {
    // Register the update listener FIRST — before the async LevelDB read — so no
    // client update that arrives during the IO round-trip is lost. A lost update
    // would leave a GAP in the stored log (update N+1 without N), and every future
    // getYDoc for this doc would then fail to integrate that gap and crash sync.
    ydoc.on("update", (update, origin) => {
      // Skip our own restore writes — they're already in LevelDB.
      if (origin === PERSISTENCE_ORIGIN) return;

      // storeUpdate is async; the surrounding sync try/catch wouldn't catch
      // promise rejections, so attach an explicit .catch so persistence failures
      // are at least logged instead of becoming an unhandledRejection.
      Promise.resolve(ldb.storeUpdate(docName, update)).catch((err) => {
        console.error(
          `⚠️  Failed to persist update for ${docName}:`,
          err?.message || err
        );
      });
    });

    // The LevelDB layer is only a SAFETY NET — the canonical document lives in
    // Postgres (posts.block_doc) via the API autosave. A corrupt or gapped safety
    // net must NEVER break live collaboration. evaluatePersistedState validates the
    // stored state and tells us what to do; see websocket/persistence.js (unit
    // tested in persistence.test.js).
    const result = await evaluatePersistedState(ldb, docName);
    collabDebug("bindState", docName, "decision", result.action, "liveDocLen", docLen(ydoc));

    if (result.action === "skip") {
      console.error(
        `⚠️  Failed to load persisted state for ${docName} — continuing without it:`,
        result.error?.message || result.error
      );
      return;
    }

    if (result.action === "clear") {
      console.warn(
        `⚠️  Persisted state for ${docName} is incomplete/corrupt — clearing it. ` +
          `The Postgres working copy is canonical; the safety net will rebuild from live edits.`
      );
      // Quarantine the corrupt entries — otherwise every subsequent reconnect
      // would re-load the same gapped log and re-trigger this branch. clearDocument
      // is scoped to this docName only; other documents are untouched. Best-effort.
      ldb.clearDocument(docName).catch((err) => {
        console.error(
          `⚠️  Failed to clear corrupt persisted state for ${docName}:`,
          err?.message || err
        );
      });
      return;
    }

    // action === "apply": safe to merge. Yjs CRDT merges are additive, so live
    // client content is never overwritten by older/empty persisted state. Tag the
    // update with our sentinel origin so the listener above skips re-persisting it.
    Y.applyUpdate(ydoc, result.update, PERSISTENCE_ORIGIN);
    collabDebug("bindState applied persisted state", docName, "liveDocLen", docLen(ydoc));
  },
  writeState: async (docName, _ydoc) => {
    // Compact the append-only update log into a single snapshot when the last client
    // disconnects. Updates are written incrementally by the bindState listener, but that
    // log was ONLY ever squashed on publish — so across a session it grew unbounded, and
    // because y-websocket destroys + rebuilds the in-memory doc from the FULL log every
    // time the client count hits zero (which a browser reload does), every reconnect
    // replayed an ever-larger history. When that history contains divergent struct sets
    // for the same content (e.g. legacy pre-fix re-seeds), the rebuilt doc oscillates and
    // the editor never converges — the "gets worse on every reload" erasure. flushDocument
    // merges all stored updates for this doc into one, keeping the replayed state compact
    // and stable. It does NOT drop content (CRDT merge), only collapses the log.
    try {
      await ldb.flushDocument(docName);
      collabDebug("writeState flushed", docName);
    } catch (err) {
      console.error(
        `⚠️  Failed to flush ${docName} on last disconnect:`,
        err?.message || err
      );
    }
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
    // decodeURIComponent throws on a malformed escape; in this async handler that would
    // be an unhandled rejection, which exits the process (every live session with it).
    let docName;
    try {
      docName = decodeURIComponent(squashMatch[1]);
    } catch {
      docName = null;
    }
    // Same rule as the upgrade handler, so every doc name this process logs or touches
    // in LevelDB is a valid post-<id>.
    if (!isCollabDocName(docName)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid document name" }));
      return;
    }
    // The API forwards the publish request's X-Request-ID, so this line joins its log.
    const requestId = requestIdFrom(req.headers["x-request-id"]);
    try {
      await ldb.flushDocument(docName);
      logEvent("info", "ws_squash", { request_id: requestId, doc: docName });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, docName }));
    } catch (err) {
      logEvent("error", "ws_squash_failed", { request_id: requestId, doc: docName, error: err.message });
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
  const docName = docNameFromReq(req);
  // Set by the upgrade handler; users are logged by id only (#155).
  const requestId = req.auth?.requestId;
  const userId = req.auth?.userId;
  const openedAt = Date.now();

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

  ws.on("close", (code) => {
    clearInterval(keepAliveInterval);
    // Log AFTER y-websocket has removed this conn so the count reflects survivors.
    setTimeout(() => {
      logEvent("info", "ws_close", {
        request_id: requestId,
        doc: docName,
        user_id: userId,
        code,
        duration_ms: Date.now() - openedAt,
        live_connections: docs.get(docName)?.conns.size ?? 0,
      });
    }, 0);
  });

  setupWSConnection(ws, req);

  // Always-on (not COLLAB_DEBUG-gated) so we can spot a runaway client count: a single
  // editor tab must show exactly 1 live connection per post. More than 1 with one tab
  // open means a zombie/duplicate binder is fighting over the doc — the kind of thing
  // that produces an unkillable server-vs-editor tug-of-war.
  logEvent("info", "ws_connect", {
    request_id: requestId,
    doc: docName,
    user_id: userId,
    role: req.auth?.role,
    live_connections: docs.get(docName)?.conns.size ?? 0,
  });
});

// Ticket auth, single-use burn, role check and doc-name validation live in upgrade.js
// (unit tested there); the ticket checks and the role lookup are in access.js
// (#223, #233). The ticket never leaves this process.
const usedTickets = new TicketReplayGuard();
server.on(
  "upgrade",
  createUpgradeHandler({
    verifyTicket: (ticket, docName) => verifyTicket(ticket, PUBLIC_KEY, { issuer: ISSUER, docName }),
    consumeTicket: (claims) => usedTickets.consume(claims),
    fetchRole: (identity, { requestId } = {}) =>
      fetchCurrentRole(INTERNAL_API_URL, identity, ROLE_LOOKUP_SECRET, { requestId }),
    accept: (req, socket, head) =>
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      }),
  }),
);

server.on("error", (error) => {
  console.error("❌ HTTP server error:", error);
});

server.listen(PORT, HOST, () => {
  console.log(
    `🔌 Yjs WebSocket server with PASETO v4.public auth running on ws://${HOST}:${PORT}`,
  );
  console.log(
    `🔒 Expecting ?ticket=<collab ticket> (issuer=${ISSUER}, audience=${TICKET_AUDIENCE}, single use)`,
  );
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
      // NOTE: y-leveldb's `destroy()` is poorly named — it does NOT delete the
      // database on disk. It calls `db.close()` on the underlying abstract-level
      // instance (just releases the file lock and flushes pending writes).
      // The actual "wipe everything" method on this class is `clearAll()`.
      // See: node_modules/y-leveldb/src/y-leveldb.js (destroy → _transact(db => db.close()))
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

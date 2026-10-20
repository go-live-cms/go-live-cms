import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, randomUUID } from "node:crypto";
import { V4 } from "paseto";
import { createUpgradeHandler } from "./upgrade.js";
import { fetchCurrentRole, TicketReplayGuard, verifyTicket, TICKET_AUDIENCE, TICKET_TYPE } from "./access.js";

const SECRET = "v4.public.eyJTOP-SECRET-TOKEN-BODY";
const ISSUED_AT = "2026-10-20T12:00:00Z";

function fakeSocket() {
  return {
    written: "",
    destroyed: false,
    listeners: {},
    on(event, fn) { this.listeners[event] = fn; },
    write(s) { this.written += s; },
    destroy() { this.destroyed = true; },
  };
}

function fakeReq(url) {
  return {
    url,
    headers: { host: "localhost:1234", origin: "http://localhost:4321", "user-agent": "UA/1", cookie: `c=${SECRET}` },
    socket: { remoteAddress: "10.0.0.7" },
  };
}

/** Captures every console method into `logs` for the rest of the test. */
function captureConsole(t) {
  const logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    t.mock.method(console, level, (...args) => logs.push({ level, text: args.map(String).join(" ") }));
  }
  return logs;
}

/** Runs one upgrade and checks, whatever happened, that the ticket never reached a log line. */
async function upgrade(handler, logs, url) {
  const req = fakeReq(url);
  const socket = fakeSocket();
  await handler(req, socket, Buffer.alloc(0));
  const text = logs.map((l) => l.text).join("\n");
  assert.ok(!text.includes("TOP-SECRET-TOKEN-BODY") && !text.includes("v4.public.e"), `ticket leaked into logs:\n${text}`);
  return { req, socket, text };
}

/**
 * Runs one upgrade through the handler with stub dependencies. `deps` overrides the
 * default happy path (a valid, unused ticket for the requested doc, for an editor).
 */
async function runUpgrade(t, url, deps = {}) {
  const logs = captureConsole(t);
  const calls = { verify: [], consume: [], fetchRole: [], accept: [] };
  const handler = createUpgradeHandler({
    verifyTicket: async (ticket, docName) => {
      calls.verify.push({ ticket, docName });
      return deps.verifyTicket
        ? deps.verifyTicket(ticket, docName)
        : { sub: "alice", username: "alice", user_id: "1", iat: ISSUED_AT, jti: "j1", doc: docName };
    },
    consumeTicket: (claims) => {
      calls.consume.push(claims.jti);
      return deps.consumeTicket ? deps.consumeTicket(claims) : true;
    },
    fetchRole: async (identity) => {
      calls.fetchRole.push(identity);
      return deps.fetchRole ? deps.fetchRole(identity) : "editor";
    },
    accept: (req, socket, head) => {
      calls.accept.push({ url: req.url, auth: req.auth, head });
      if (deps.accept) deps.accept(req, socket, head);
    },
  });
  const result = await upgrade(handler, logs, url);
  return { ...result, logs, calls };
}

const status = (socket) => socket.written.split("\r\n")[0];

test("a valid editor connects; req.url is stripped before accept and no client context is logged", async (t) => {
  const { socket, calls, text } = await runUpgrade(t, `/post-12?ticket=${SECRET}`);
  assert.equal(socket.written, "");
  assert.equal(socket.destroyed, false);
  assert.deepEqual(calls.verify, [{ ticket: SECRET, docName: "post-12" }]);
  assert.deepEqual(calls.consume, ["j1"]);
  // The role lookup gets the ticket's identity, never the ticket itself.
  assert.deepEqual(calls.fetchRole, [{ userId: "1", issuedAt: Date.parse(ISSUED_AT) / 1000 }]);
  assert.equal(calls.accept.length, 1);
  assert.equal(calls.accept[0].url, "/post-12");
  assert.deepEqual(calls.accept[0].auth, { sub: "alice", userId: "1", username: "alice", role: "editor" });
  assert.match(text, /upgrade request for doc: post-12/);
  assert.match(text, /Ticket accepted for user alice \(role: editor\), doc post-12/);
  assert.ok(!text.includes("10.0.0.7") && !text.includes("UA/1"), text);
});

test("the pre-#233 ?token= param is refused (access tokens never open a socket)", async (t) => {
  const { socket, calls } = await runUpgrade(t, `/post-12?token=${SECRET}`);
  assert.equal(status(socket), "HTTP/1.1 401 Unauthorized");
  assert.deepEqual(calls.verify, []);
  assert.deepEqual(calls.accept, []);
});

test("the proxy's /collab prefix is dropped, so the doc is post-<id>", async (t) => {
  const { calls, text } = await runUpgrade(t, `/collab/post-12?ticket=${SECRET}`);
  assert.equal(calls.accept[0].url, "/post-12");
  assert.equal(calls.verify[0].docName, "post-12");
  assert.match(text, /doc: post-12/);
});

test("an invalid doc name gets 400 before any auth work, with client context logged", async (t) => {
  const { socket, calls, logs } = await runUpgrade(t, `/evil%20doc?ticket=${SECRET}`);
  assert.equal(status(socket), "HTTP/1.1 400 Bad Request");
  assert.equal(socket.destroyed, true);
  assert.deepEqual(calls.verify, []);
  assert.deepEqual(calls.consume, []);
  assert.deepEqual(calls.fetchRole, []);
  assert.deepEqual(calls.accept, []);
  const line = logs.find((l) => l.text.includes("Invalid document name"));
  assert.equal(line.level, "warn");
  assert.match(line.text, /doc evil\?20doc \| origin="http:\/\/localhost:4321" ua="UA\/1" peer="10\.0\.0\.7"/);
});

test("a missing credential gets 401 without verifying", async (t) => {
  const { socket, calls, logs } = await runUpgrade(t, "/post-12");
  assert.equal(status(socket), "HTTP/1.1 401 Unauthorized");
  assert.deepEqual(calls.verify, []);
  assert.equal(logs.find((l) => l.text.includes("No ticket provided")).level, "error");
});

test("an invalid ticket gets 401 and is neither burned nor looked up", async (t) => {
  const { socket, calls, text } = await runUpgrade(t, `/post-12?ticket=${SECRET}`, {
    verifyTicket: () => {
      throw new Error("ticket was issued for a different document");
    },
  });
  assert.equal(status(socket), "HTTP/1.1 401 Unauthorized");
  assert.deepEqual(calls.consume, []);
  assert.deepEqual(calls.fetchRole, []);
  assert.deepEqual(calls.accept, []);
  assert.match(text, /Ticket rejected: ticket was issued for a different document.*peer="10\.0\.0\.7"/);
});

test("an already-used ticket gets 401 without a role lookup", async (t) => {
  const { socket, calls, logs } = await runUpgrade(t, `/post-12?ticket=${SECRET}`, { consumeTicket: () => false });
  assert.equal(status(socket), "HTTP/1.1 401 Unauthorized");
  assert.deepEqual(calls.fetchRole, []);
  assert.deepEqual(calls.accept, []);
  assert.equal(logs.find((l) => l.text.includes("Ticket already used")).level, "warn");
});

test("a ticket without a usable user_id/iat gets 403 without a role lookup", async (t) => {
  const { socket, calls } = await runUpgrade(t, `/post-12?ticket=${SECRET}`, {
    verifyTicket: (_ticket, doc) => ({ sub: "alice", user_id: "7/../../users/me", iat: ISSUED_AT, jti: "j1", doc }),
  });
  assert.equal(status(socket), "HTTP/1.1 403 Forbidden");
  assert.deepEqual(calls.fetchRole, []);
});

test("a failed role lookup gets 503, and the ticket stays burned", async (t) => {
  const { socket, calls } = await runUpgrade(t, `/post-12?ticket=${SECRET}`, {
    fetchRole: () => {
      throw new Error("role lookup failed: API responded 500");
    },
  });
  assert.equal(status(socket), "HTTP/1.1 503 Service Unavailable");
  assert.deepEqual(calls.consume, ["j1"]);
  assert.deepEqual(calls.accept, []);
});

test("a contributor, deleted user or revoked ticket (null role) gets 403", async (t) => {
  for (const role of ["contributor", null]) {
    const { socket, calls, logs } = await runUpgrade(t, `/post-12?ticket=${SECRET}`, { fetchRole: () => role });
    assert.equal(status(socket), "HTTP/1.1 403 Forbidden", String(role));
    assert.deepEqual(calls.accept, []);
    assert.equal(logs.find((l) => l.text.includes("Forbidden")).level, "warn");
  }
});

test("a throwing handshake is answered with 500 instead of escaping the listener", async (t) => {
  const { socket } = await runUpgrade(t, `/post-12?ticket=${SECRET}`, {
    accept: () => {
      throw new Error("boom");
    },
  });
  assert.equal(status(socket), "HTTP/1.1 500 Internal Server Error");
  assert.equal(socket.destroyed, true);
});

test("a socket error listener is attached first, so a client reset can't crash the process", async (t) => {
  const { socket } = await runUpgrade(t, "/post-12");
  assert.equal(typeof socket.listeners.error, "function");
  socket.listeners.error(Object.assign(new Error("reset"), { code: "ECONNRESET" }));
});

// --- Wired like server.js: real tickets, real verifyTicket / TicketReplayGuard /
// fetchCurrentRole, and a fake internal API (#223, #233). ---------------------------

const ISSUER = "golive.auth";
const privateKey = await V4.generateKey("public");
const publicKey = createPublicKey(privateKey);

/** Signs a ticket shaped like token/ws_ticket.go's. */
function signTicket(claims = {}, { audience = TICKET_AUDIENCE } = {}) {
  return V4.sign(
    { user_id: "7", username: "alice", token_type: TICKET_TYPE, doc: "post-12", ...claims },
    privateKey,
    { issuer: ISSUER, audience, expiresIn: "30s", jti: randomUUID() },
  );
}

/** A fake internal API that records requests and answers with `role` (or `status`). */
function internalApi({ role = "editor", status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { status, ok: status >= 200 && status < 300, json: async () => ({ role }) };
  };
  return { calls, fetchImpl };
}

function wiredHandler(fetchImpl, accepted) {
  const usedTickets = new TicketReplayGuard();
  return createUpgradeHandler({
    verifyTicket: (ticket, docName) => verifyTicket(ticket, publicKey, { issuer: ISSUER, docName }),
    consumeTicket: (claims) => usedTickets.consume(claims),
    fetchRole: (identity) => fetchCurrentRole("http://api:8081", identity, "s3cret", { fetchImpl }),
    accept: (req) => accepted.push(req.auth),
  });
}

test("wired: an editor's ticket opens a socket; the ticket is never sent to the API", async (t) => {
  const logs = captureConsole(t);
  const api = internalApi();
  const accepted = [];
  const ticket = await signTicket();
  const { socket } = await upgrade(wiredHandler(api.fetchImpl, accepted), logs, `/post-12?ticket=${ticket}`);

  assert.equal(socket.written, "");
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].role, "editor");
  assert.equal(api.calls.length, 1);
  assert.match(api.calls[0].url, /^http:\/\/api:8081\/internal\/users\/7\/role\?issued_at=\d+$/);
  assert.equal(api.calls[0].init.headers.Authorization, "Bearer s3cret");
  assert.ok(!JSON.stringify(api.calls).includes(ticket), "ticket must not leave the WS process");
  assert.ok(!logs.some((l) => l.text.includes(ticket)), "ticket must not be logged");
});

test("wired: a ticket can be used once; the replay is refused before the API is asked", async (t) => {
  const logs = captureConsole(t);
  const api = internalApi();
  const accepted = [];
  const handler = wiredHandler(api.fetchImpl, accepted);
  const ticket = await signTicket();

  await upgrade(handler, logs, `/post-12?ticket=${ticket}`);
  const replay = await upgrade(handler, logs, `/post-12?ticket=${ticket}`);

  assert.equal(accepted.length, 1);
  assert.equal(status(replay.socket), "HTTP/1.1 401 Unauthorized");
  assert.equal(api.calls.length, 1);
});

test("wired: the DB role decides, not the ticket (a contributor gets 403 even if it claims admin)", async (t) => {
  const logs = captureConsole(t);
  const api = internalApi({ role: "contributor" });
  const accepted = [];
  const ticket = await signTicket({ role: "admin" });
  const { socket } = await upgrade(wiredHandler(api.fetchImpl, accepted), logs, `/post-12?ticket=${ticket}`);
  assert.equal(status(socket), "HTTP/1.1 403 Forbidden");
  assert.equal(accepted.length, 0);
});

test("wired: the API refusing the user (gone, or ticket predates a password change) gives 403", async (t) => {
  for (const apiStatus of [403, 404]) {
    const logs = captureConsole(t);
    const api = internalApi({ status: apiStatus });
    const accepted = [];
    const ticket = await signTicket();
    const { socket } = await upgrade(wiredHandler(api.fetchImpl, accepted), logs, `/post-12?ticket=${ticket}`);
    assert.equal(status(socket), "HTTP/1.1 403 Forbidden", String(apiStatus));
    assert.equal(accepted.length, 0);
  }
});

test("wired: a rejected ROLE_LOOKUP_SECRET is a 503 config error, not a 403", async (t) => {
  const logs = captureConsole(t);
  const api = internalApi({ status: 401 });
  const { socket } = await upgrade(wiredHandler(api.fetchImpl, []), logs, `/post-12?ticket=${await signTicket()}`);
  assert.equal(status(socket), "HTTP/1.1 503 Service Unavailable");
});

test("wired: an access token, a ticket for another doc, or a foreign-key ticket gets 401 with no API call", async (t) => {
  const otherKey = await V4.generateKey("public");
  const access = await V4.sign(
    { user_id: "7", token_type: "access" },
    privateKey,
    { issuer: ISSUER, audience: "golive.admin", expiresIn: "15m", jti: randomUUID() },
  );
  const otherDoc = await signTicket({ doc: "post-13" });
  const foreign = await V4.sign(
    { user_id: "7", token_type: TICKET_TYPE, doc: "post-12" },
    otherKey,
    { issuer: ISSUER, audience: TICKET_AUDIENCE, expiresIn: "30s", jti: randomUUID() },
  );
  for (const credential of [access, otherDoc, foreign]) {
    const logs = captureConsole(t);
    const api = internalApi();
    const { socket } = await upgrade(wiredHandler(api.fetchImpl, []), logs, `/post-12?ticket=${credential}`);
    assert.equal(status(socket), "HTTP/1.1 401 Unauthorized");
    assert.equal(api.calls.length, 0);
  }
});

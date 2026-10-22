import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, randomUUID } from "node:crypto";
import { V4 } from "paseto";
import { createUpgradeHandler } from "./upgrade.js";
import { fetchDocAccess, TicketReplayGuard, verifyTicket, TICKET_AUDIENCE, TICKET_TYPE } from "./access.js";

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

function fakeReq(url, extraHeaders = {}) {
  return {
    url,
    headers: {
      host: "localhost:1234",
      origin: "http://localhost:4321",
      "user-agent": "UA/1",
      cookie: `c=${SECRET}`,
      ...extraHeaders,
    },
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

/** The captured lines, parsed (upgrade.js logs one JSON object per line). */
const events = (logs) => logs.map((l) => ({ ...JSON.parse(l.text), consoleLevel: l.level }));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Runs one upgrade and checks, whatever happened, that the ticket never reached a log line. */
async function upgrade(handler, logs, url, headers = {}) {
  const req = fakeReq(url, headers);
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
async function runUpgrade(t, url, deps = {}, headers = {}) {
  const logs = captureConsole(t);
  const calls = { verify: [], consume: [], fetchAccess: [], fetchAccessOpts: [], accept: [] };
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
    fetchAccess: async (identity, docName, opts) => {
      calls.fetchAccess.push({ ...identity, docName });
      calls.fetchAccessOpts.push(opts);
      return deps.fetchAccess ? deps.fetchAccess(identity, docName) : { role: "editor", canEdit: true };
    },
    accept: (req, socket, head) => {
      calls.accept.push({ url: req.url, auth: req.auth, head });
      if (deps.accept) deps.accept(req, socket, head);
    },
  });
  const result = await upgrade(handler, logs, url, headers);
  return { ...result, logs, calls };
}

const status = (socket) => socket.written.split("\r\n")[0];

test("a valid editor connects; req.url is stripped before accept and no client context is logged", async (t) => {
  const { socket, calls, text, logs } = await runUpgrade(t, `/post-12?ticket=${SECRET}`);
  assert.equal(socket.written, "");
  assert.equal(socket.destroyed, false);
  assert.deepEqual(calls.verify, [{ ticket: SECRET, docName: "post-12" }]);
  assert.deepEqual(calls.consume, ["j1"]);
  // The access lookup gets the ticket's identity and the doc, never the ticket itself.
  assert.deepEqual(calls.fetchAccess, [{ userId: "1", issuedAt: Date.parse(ISSUED_AT) / 1000, docName: "post-12" }]);
  assert.equal(calls.accept.length, 1);
  assert.equal(calls.accept[0].url, "/post-12");
  const { requestId, ...auth } = calls.accept[0].auth;
  assert.deepEqual(auth, { sub: "alice", userId: "1", username: "alice", role: "editor" });
  assert.match(requestId, UUID, "no X-Request-ID came in, so one is generated");
  assert.deepEqual(calls.fetchAccessOpts, [{ requestId }], "the request id is forwarded on the access lookup");
  const logged = events(logs);
  assert.deepEqual(logged.map((e) => e.event), ["ws_upgrade"]);
  assert.equal(logged[0].doc, "post-12");
  assert.equal(logged[0].request_id, requestId);
  assert.ok(!text.includes("10.0.0.7") && !text.includes("UA/1"), text);
  assert.ok(!text.includes("alice"), "usernames are not logged (#155)");
});

test("the pre-#233 ?token= param is refused (access tokens never open a socket)", async (t) => {
  const { socket, calls } = await runUpgrade(t, `/post-12?token=${SECRET}`);
  assert.equal(status(socket), "HTTP/1.1 401 Unauthorized");
  assert.deepEqual(calls.verify, []);
  assert.deepEqual(calls.accept, []);
});

test("the proxy's /collab prefix is dropped, so the doc is post-<id>", async (t) => {
  const { calls, logs } = await runUpgrade(t, `/collab/post-12?ticket=${SECRET}`);
  assert.equal(calls.accept[0].url, "/post-12");
  assert.equal(calls.verify[0].docName, "post-12");
  assert.equal(events(logs)[0].doc, "post-12");
});

test("an invalid doc name gets 400 before any auth work, with client context logged", async (t) => {
  const { socket, calls, logs } = await runUpgrade(t, `/evil%20doc?ticket=${SECRET}`);
  assert.equal(status(socket), "HTTP/1.1 400 Bad Request");
  assert.equal(socket.destroyed, true);
  assert.deepEqual(calls.verify, []);
  assert.deepEqual(calls.consume, []);
  assert.deepEqual(calls.fetchAccess, []);
  assert.deepEqual(calls.accept, []);
  const deny = events(logs).find((e) => e.event === "ws_deny");
  assert.equal(deny.consoleLevel, "warn");
  assert.equal(deny.level, "warn");
  assert.equal(deny.status, 400);
  assert.equal(deny.reason, "Invalid document name");
  assert.equal(deny.doc, "evil?20doc");
  assert.equal(deny.client, 'origin="http://localhost:4321" ua="UA/1" peer="10.0.0.7"');
  assert.match(deny.request_id, UUID);
});

test("a missing credential gets 401 without verifying", async (t) => {
  const { socket, calls, logs } = await runUpgrade(t, "/post-12");
  assert.equal(status(socket), "HTTP/1.1 401 Unauthorized");
  assert.deepEqual(calls.verify, []);
  assert.equal(logs.find((l) => l.text.includes("No ticket provided")).level, "error");
});

test("an invalid ticket gets 401 and is neither burned nor looked up", async (t) => {
  const { socket, calls, logs } = await runUpgrade(t, `/post-12?ticket=${SECRET}`, {
    verifyTicket: () => {
      throw new Error("ticket was issued for a different document");
    },
  });
  assert.equal(status(socket), "HTTP/1.1 401 Unauthorized");
  assert.deepEqual(calls.consume, []);
  assert.deepEqual(calls.fetchAccess, []);
  assert.deepEqual(calls.accept, []);
  const deny = events(logs).find((e) => e.event === "ws_deny");
  assert.equal(deny.status, 401);
  assert.equal(deny.reason, "Ticket rejected: ticket was issued for a different document");
  assert.match(deny.client, /peer="10\.0\.0\.7"/);
});

test("an already-used ticket gets 401 without an access lookup", async (t) => {
  const { socket, calls, logs } = await runUpgrade(t, `/post-12?ticket=${SECRET}`, { consumeTicket: () => false });
  assert.equal(status(socket), "HTTP/1.1 401 Unauthorized");
  assert.deepEqual(calls.fetchAccess, []);
  assert.deepEqual(calls.accept, []);
  const deny = events(logs).find((e) => e.event === "ws_deny");
  assert.equal(deny.consoleLevel, "warn");
  assert.equal(deny.reason, "Ticket already used");
  assert.equal(deny.user_id, "1", "denials after verification name the user by id");
});

test("a well-formed incoming X-Request-ID is kept, logged, forwarded and handed to the connection", async (t) => {
  const id = "edge-proxy-0123456789";
  const { calls, logs } = await runUpgrade(t, `/post-12?ticket=${SECRET}`, {}, { "x-request-id": id });
  assert.equal(calls.accept[0].auth.requestId, id);
  assert.deepEqual(calls.fetchAccessOpts, [{ requestId: id }]);
  assert.ok(events(logs).every((e) => e.request_id === id));
});

test("a malformed incoming X-Request-ID is replaced, so it can't forge log content", async (t) => {
  const bad = 'x"},"event":"forged';
  const { calls, logs } = await runUpgrade(t, `/post-12?ticket=${SECRET}`, {}, { "x-request-id": bad });
  assert.match(calls.accept[0].auth.requestId, UUID);
  assert.ok(!logs.some((l) => l.text.includes("forged")));
});

test("a ticket without a usable user_id/iat gets 403 without an access lookup", async (t) => {
  const { socket, calls } = await runUpgrade(t, `/post-12?ticket=${SECRET}`, {
    verifyTicket: (_ticket, doc) => ({ sub: "alice", user_id: "7/../../users/me", iat: ISSUED_AT, jti: "j1", doc }),
  });
  assert.equal(status(socket), "HTTP/1.1 403 Forbidden");
  assert.deepEqual(calls.fetchAccess, []);
});

test("a failed access lookup gets 503, and the ticket stays burned", async (t) => {
  const { socket, calls } = await runUpgrade(t, `/post-12?ticket=${SECRET}`, {
    fetchAccess: () => {
      throw new Error("access lookup failed: API responded 500");
    },
  });
  assert.equal(status(socket), "HTTP/1.1 503 Service Unavailable");
  assert.deepEqual(calls.consume, ["j1"]);
  assert.deepEqual(calls.accept, []);
});

test("a user the API won't let edit this doc, a deleted user or a revoked ticket (null) gets 403", async (t) => {
  for (const access of [{ role: "contributor", canEdit: false }, { role: "editor", canEdit: false }, null]) {
    const { socket, calls, logs } = await runUpgrade(t, `/post-12?ticket=${SECRET}`, { fetchAccess: () => access });
    assert.equal(status(socket), "HTTP/1.1 403 Forbidden", JSON.stringify(access));
    assert.deepEqual(calls.accept, []);
    assert.equal(logs.find((l) => l.text.includes("Forbidden")).level, "warn");
  }
});

test("a contributor the API lets edit this doc (their own post, #135) connects", async (t) => {
  const { socket, calls } = await runUpgrade(t, `/post-12?ticket=${SECRET}`, {
    fetchAccess: () => ({ role: "contributor", canEdit: true }),
  });
  assert.equal(socket.written, "");
  assert.equal(calls.accept.length, 1);
  assert.equal(calls.accept[0].auth.role, "contributor");
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
// fetchDocAccess, and a fake internal API (#223, #233, #135). ---------------------------

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

/** A fake internal API that records requests and answers with `role`/`canEdit` (or `status`). */
function internalApi({ role = "editor", canEdit = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { status, ok: status >= 200 && status < 300, json: async () => ({ role, can_edit: canEdit }) };
  };
  return { calls, fetchImpl };
}

function wiredHandler(fetchImpl, accepted) {
  const usedTickets = new TicketReplayGuard();
  return createUpgradeHandler({
    verifyTicket: (ticket, docName) => verifyTicket(ticket, publicKey, { issuer: ISSUER, docName }),
    consumeTicket: (claims) => usedTickets.consume(claims),
    fetchAccess: (identity, docName, opts) => fetchDocAccess("http://api:8081", identity, docName, "s3cret", { fetchImpl, ...opts }),
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
  assert.match(api.calls[0].url, /^http:\/\/api:8081\/internal\/users\/7\/access\?doc=post-12&issued_at=\d+$/);
  assert.equal(api.calls[0].init.headers.Authorization, "Bearer s3cret");
  assert.equal(api.calls[0].init.headers["X-Request-ID"], accepted[0].requestId);
  assert.match(accepted[0].requestId, UUID);
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

test("wired: the API decides, not the ticket (a contributor on someone else's post gets 403 even if it claims admin)", async (t) => {
  const logs = captureConsole(t);
  const api = internalApi({ role: "contributor", canEdit: false });
  const accepted = [];
  const ticket = await signTicket({ role: "admin" });
  const { socket } = await upgrade(wiredHandler(api.fetchImpl, accepted), logs, `/post-12?ticket=${ticket}`);
  assert.equal(status(socket), "HTTP/1.1 403 Forbidden");
  assert.equal(accepted.length, 0);
});

test("wired: the API refusing the user (user or post gone, or ticket predates a password change) gives 403", async (t) => {
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

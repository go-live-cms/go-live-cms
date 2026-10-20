import { test } from "node:test";
import assert from "node:assert/strict";
import { createUpgradeHandler } from "./upgrade.js";

const SECRET = "v4.public.eyJTOP-SECRET-TOKEN-BODY";

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

/**
 * Runs one upgrade through the handler with all console output captured. `deps`
 * overrides the default happy-path dependencies (valid token, editor role).
 */
async function runUpgrade(t, url, deps = {}) {
  const logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    t.mock.method(console, level, (...args) => logs.push({ level, text: args.map(String).join(" ") }));
  }
  const calls = { verify: [], fetchRole: [], accept: [] };
  const handler = createUpgradeHandler({
    verifyCredential: async (credential) => {
      calls.verify.push(credential);
      return deps.verifyCredential
        ? deps.verifyCredential(credential)
        : { payload: { sub: "u1", username: "alice", role: "editor" }, footer: { kid: "k1" } };
    },
    fetchRole: async (credential) => {
      calls.fetchRole.push(credential);
      return deps.fetchRole ? deps.fetchRole(credential) : "editor";
    },
    accept: (req, socket, head) => {
      calls.accept.push({ url: req.url, auth: req.auth, head });
      if (deps.accept) deps.accept(req, socket, head);
    },
  });
  const req = fakeReq(url);
  const socket = fakeSocket();
  await handler(req, socket, Buffer.alloc(0));
  const text = logs.map((l) => l.text).join("\n");
  // Whatever happened, the token must never reach a log line.
  assert.ok(!text.includes("SECRET"), `token leaked into logs:\n${text}`);
  return { req, socket, logs, text, calls };
}

const status = (socket) => socket.written.split("\r\n")[0];

test("a valid editor connects; req.url is stripped before accept and no client context is logged", async (t) => {
  const { socket, calls, text } = await runUpgrade(t, `/post-12?ticket=${SECRET}`);
  assert.equal(socket.written, "");
  assert.equal(socket.destroyed, false);
  assert.deepEqual(calls.verify, [SECRET]);
  assert.deepEqual(calls.fetchRole, [SECRET]);
  assert.equal(calls.accept.length, 1);
  assert.equal(calls.accept[0].url, "/post-12");
  assert.equal(calls.accept[0].auth.username, "alice");
  assert.equal(calls.accept[0].auth.role, "editor");
  assert.match(text, /upgrade request for doc: post-12/);
  assert.match(text, /Verified role: editor/);
  assert.ok(!text.includes("10.0.0.7") && !text.includes("UA/1"), text);
});

test("the legacy ?token= param still works", async (t) => {
  const { calls } = await runUpgrade(t, `/post-12?token=${SECRET}`);
  assert.deepEqual(calls.verify, [SECRET]);
  assert.equal(calls.accept[0].url, "/post-12");
});

test("the proxy's /collab prefix is dropped, so the doc is post-<id>", async (t) => {
  const { calls, text } = await runUpgrade(t, `/collab/post-12?ticket=${SECRET}`);
  assert.equal(calls.accept[0].url, "/post-12");
  assert.match(text, /doc: post-12/);
});

test("an invalid doc name gets 400 before any auth work, with client context logged", async (t) => {
  const { socket, calls, logs } = await runUpgrade(t, `/evil%20doc?ticket=${SECRET}`);
  assert.equal(status(socket), "HTTP/1.1 400 Bad Request");
  assert.equal(socket.destroyed, true);
  assert.deepEqual(calls.verify, []);
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
  assert.equal(logs.find((l) => l.text.includes("No ticket or token")).level, "error");
});

test("an invalid token gets 401 and the role is never looked up", async (t) => {
  const { socket, calls, text } = await runUpgrade(t, `/post-12?ticket=${SECRET}`, {
    verifyCredential: () => {
      throw new Error("Token invalid for any allowed audience: golive.admin");
    },
  });
  assert.equal(status(socket), "HTTP/1.1 401 Unauthorized");
  assert.deepEqual(calls.fetchRole, []);
  assert.deepEqual(calls.accept, []);
  assert.match(text, /authentication failed: Token invalid.*peer="10\.0\.0\.7"/);
});

test("a failed role lookup gets 503", async (t) => {
  const { socket, calls } = await runUpgrade(t, `/post-12?ticket=${SECRET}`, {
    fetchRole: () => {
      throw new Error("role lookup failed: API responded 500");
    },
  });
  assert.equal(status(socket), "HTTP/1.1 503 Service Unavailable");
  assert.deepEqual(calls.accept, []);
});

test("a contributor (or deleted user) gets 403", async (t) => {
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

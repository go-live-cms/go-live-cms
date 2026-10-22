import { test } from "node:test";
import assert from "node:assert/strict";
import { docNameForLog, logEvent, requestIdFrom, upgradeContextForLog, MAX_LOG_FIELD_LEN } from "./logsafe.js";

const SECRET = "v4.public.eyJTOP-SECRET-TOKEN-BODY";

/** A fake upgrade request carrying the token everywhere a client could put it. */
function fakeReq(overrides = {}) {
  return {
    url: `/post-12?ticket=${SECRET}&token=${SECRET}`,
    headers: {
      host: "localhost:1234",
      origin: "http://localhost:4321",
      "user-agent": "Mozilla/5.0 Test",
      authorization: `Bearer ${SECRET}`,
      cookie: `refresh=${SECRET}`,
      "sec-websocket-protocol": SECRET,
    },
    socket: { remoteAddress: "172.18.0.1" },
    ...overrides,
  };
}

test("upgrade context never includes the token, whatever header carries it", () => {
  const ctx = upgradeContextForLog(fakeReq());
  assert.ok(!ctx.includes("SECRET"), ctx);
  assert.equal(ctx, 'origin="http://localhost:4321" ua="Mozilla/5.0 Test" peer="172.18.0.1"');
});

test("upgrade context marks missing fields instead of throwing", () => {
  assert.equal(upgradeContextForLog({ headers: {} }), "origin=- ua=- peer=-");
  assert.equal(upgradeContextForLog(undefined), "origin=- ua=- peer=-");
});

test("upgrade context quotes and caps attacker-controlled values", () => {
  const forged = '" ✅ Token verified successfully for user: admin';
  const ctx = upgradeContextForLog(fakeReq({ headers: { "user-agent": forged + "x".repeat(500) } }));
  // The embedded quote is escaped, so the value can't break out of ua="…".
  assert.ok(ctx.startsWith('origin=- ua="\\" ✅'), ctx);
  assert.ok(ctx.includes(`…(+${forged.length + 500 - MAX_LOG_FIELD_LEN})`), ctx);
});

test("doc name passes post-<id> through unchanged", () => {
  assert.equal(docNameForLog("post-2892"), "post-2892");
});

test("doc name neutralises separators and fake log text", () => {
  assert.equal(
    docNameForLog("post-1 | ✅ Token verified for user: admin"),
    "post-1?????Token?verified?for?user:?admin",
  );
});

test("doc name is length-capped and never empty", () => {
  const long = docNameForLog("a".repeat(5000));
  assert.equal(long, `${"a".repeat(MAX_LOG_FIELD_LEN)}…(+${5000 - MAX_LOG_FIELD_LEN})`);
  assert.equal(docNameForLog(""), "(none)");
  assert.equal(docNameForLog(undefined), "(none)");
});

test("requestIdFrom keeps a well-formed id and replaces anything else with a UUID", () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  assert.equal(requestIdFrom("0123456789abcdef"), "0123456789abcdef");
  assert.equal(requestIdFrom(["edge-req.42:abc", "second"]), "edge-req.42:abc");
  for (const bad of [undefined, "", "short", "has space here", 'quote"in-it-123', "x".repeat(129), "line\nbreak-123"]) {
    assert.match(requestIdFrom(bad), UUID, JSON.stringify(bad));
  }
});

test("logEvent writes one JSON line per event, on the console method for its level", (t) => {
  const lines = [];
  for (const level of ["log", "warn", "error"]) {
    t.mock.method(console, level, (line) => lines.push({ level, line }));
  }
  logEvent("info", "ws_connect", { request_id: "r-12345678", doc: "post-1", user_id: "7", skipped: undefined, none: null });
  logEvent("warn", "ws_deny", { status: 403, reason: "x".repeat(1000) });
  logEvent("error", "ws_squash_failed", { reason: 'a"b\nc' });

  assert.deepEqual(lines.map((l) => l.level), ["log", "warn", "error"]);
  const [connect, deny, failed] = lines.map((l) => JSON.parse(l.line));
  assert.equal(connect.event, "ws_connect");
  assert.equal(connect.level, "info");
  assert.equal(connect.request_id, "r-12345678");
  assert.ok(!("skipped" in connect) && !("none" in connect));
  assert.ok(!Number.isNaN(Date.parse(connect.time)));
  assert.equal(deny.status, 403);
  assert.ok(deny.reason.length < 1000, "long strings are capped");
  assert.equal(failed.reason, 'a"b\nc');
  assert.ok(!lines[2].line.includes("\n"), "a value can't break the line");
});
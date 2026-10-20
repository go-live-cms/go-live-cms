import { test } from "node:test";
import assert from "node:assert/strict";
import { docNameForLog, upgradeContextForLog, MAX_LOG_FIELD_LEN } from "./logsafe.js";

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

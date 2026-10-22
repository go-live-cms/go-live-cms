import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import { randomUUID } from "node:crypto";
import { V4 } from "paseto";
import {
  fetchDocAccess,
  isCollabDocName,
  publicKeyFromHex,
  stripCollabPrefix,
  takeCredential,
  ticketIdentity,
  verifyTicket,
  TicketReplayGuard,
  TICKET_AUDIENCE,
  TICKET_CLOCK_TOLERANCE_MS,
  TICKET_TYPE,
} from "./access.js";

/** Fake fetch that records the request and answers with the given status/body. */
function fakeFetch(status, body = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    };
  };
  return { impl, calls };
}

const ISSUER = "golive.auth";
const privateKey = await V4.generateKey("public");
const publicKey = createPublicKey(privateKey);

/** Signs a token shaped like the API's (token/ws_ticket.go), with overridable claims. */
function sign(claims = {}, { audience = TICKET_AUDIENCE, expiresIn = "30s", key = privateKey } = {}) {
  return V4.sign(
    { user_id: "7", username: "alice", token_type: TICKET_TYPE, doc: "post-12", ...claims },
    key,
    { issuer: ISSUER, audience, expiresIn, jti: randomUUID() },
  );
}

test("isCollabDocName accepts only post-<positive id>", () => {
  for (const ok of ["post-1", "post-2892", "post-9223372036854775807"]) {
    assert.equal(isCollabDocName(ok), true, ok);
  }
  for (const bad of ["", "post-", "post-0", "post-01", "post-1a", "Post-1", "post-1/x", "post-1 | x",
    "anything", "_internal/documents/post-1/squash", "post-12345678901234567890", undefined, 1]) {
    assert.equal(isCollabDocName(bad), false, String(bad));
  }
});

test("takeCredential reads ?ticket= and strips the query from req.url", () => {
  const req = { url: "/post-12?ticket=v4.public.SECRET&x=1#frag" };
  assert.equal(takeCredential(req), "v4.public.SECRET");
  assert.equal(req.url, "/post-12");
});

test("takeCredential ignores the pre-#233 ?token= param but still strips it", () => {
  const req = { url: "/post-12?token=v4.public.SECRET" };
  assert.equal(takeCredential(req), null);
  assert.equal(req.url, "/post-12");
});

test("takeCredential reads ticket (not token) and decodes percent-encoding", () => {
  const req = { url: "/post-1?token=old&ticket=v4.public.a%2Bb" };
  assert.equal(takeCredential(req), "v4.public.a+b");
});

test("takeCredential returns null without a credential and still strips the query", () => {
  for (const url of ["/post-1", "/post-1?", "/post-1?ticket=", "/post-1#ticket=x", undefined]) {
    const req = { url };
    assert.equal(takeCredential(req), null, String(url));
    assert.ok(!req.url.includes("?") && !req.url.includes("#"), req.url);
  }
});

test("stripCollabPrefix drops the proxy's /collab prefix and nothing else", () => {
  const cases = [
    ["/collab/post-12", "/post-12"],
    ["/post-12", "/post-12"],
    ["/collabx/post-12", "/collabx/post-12"],
    ["/collab", "/collab"],
    ["/x/collab/post-12", "/x/collab/post-12"],
  ];
  for (const [before, after] of cases) {
    const req = { url: before };
    stripCollabPrefix(req);
    assert.equal(req.url, after, before);
  }
});

test("verifyTicket accepts a ticket for this doc", async () => {
  const payload = await verifyTicket(await sign(), publicKey, { issuer: ISSUER, docName: "post-12" });
  assert.equal(payload.username, "alice");
  assert.equal(payload.doc, "post-12");
});

test("verifyTicket rejects a ticket minted for another doc", async () => {
  await assert.rejects(
    verifyTicket(await sign(), publicKey, { issuer: ISSUER, docName: "post-13" }),
    /different document/,
  );
});

test("verifyTicket rejects an access token (wrong audience)", async () => {
  const access = await sign({ token_type: "access", doc: undefined }, { audience: "golive.admin" });
  await assert.rejects(verifyTicket(access, publicKey, { issuer: ISSUER, docName: "post-12" }));
});

test("verifyTicket rejects a non-ticket token even with the ticket audience", async () => {
  const access = await sign({ token_type: "access" });
  await assert.rejects(
    verifyTicket(access, publicKey, { issuer: ISSUER, docName: "post-12" }),
    /not a collab ticket/,
  );
});

test("verifyTicket rejects expired, foreign-key and wrong-issuer tickets", async () => {
  const opts = { issuer: ISSUER, docName: "post-12" };
  const expired = await V4.sign(
    { token_type: TICKET_TYPE, doc: "post-12", exp: new Date(Date.now() - 60_000).toISOString() },
    privateKey,
    { issuer: ISSUER, audience: TICKET_AUDIENCE },
  );
  await assert.rejects(verifyTicket(expired, publicKey, opts));

  const otherKey = await V4.generateKey("public");
  await assert.rejects(verifyTicket(await sign({}, { key: otherKey }), publicKey, opts));

  await assert.rejects(verifyTicket(await sign(), publicKey, { ...opts, issuer: "someone.else" }));
});

test("publicKeyFromHex turns the API's raw hex public key into a verifying key", async () => {
  // The raw key is the last 32 bytes of the SPKI DER, which is what the API's
  // PASETO_V4_PUBLIC_KEY_HEX holds.
  const hex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const opts = { issuer: ISSUER, docName: "post-12" };
  const payload = await verifyTicket(await sign(), publicKeyFromHex(`  ${hex.toUpperCase()}\n`), opts);
  assert.equal(payload.user_id, "7");

  const otherKey = createPublicKey(await V4.generateKey("public"));
  const otherHex = otherKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  await assert.rejects(verifyTicket(await sign(), publicKeyFromHex(otherHex), opts));
});

test("publicKeyFromHex rejects anything but 64 hex characters", () => {
  for (const bad of ["", "abc", "zz".repeat(32), "ab".repeat(31), "ab".repeat(33), "ab".repeat(64)]) {
    assert.throws(() => publicKeyFromHex(bad), /64 hex characters/);
  }
});

/** Identity as ticketIdentity returns it, for the access-lookup tests. */
const identity = { userId: "7", issuedAt: 1760000000 };

test("ticketIdentity extracts user_id and iat (as Unix seconds)", () => {
  assert.deepEqual(ticketIdentity({ user_id: "42", iat: "2025-10-09T08:53:20Z" }), {
    userId: "42",
    issuedAt: 1760000000,
  });
  assert.deepEqual(ticketIdentity({ user_id: 42, iat: "2025-10-09T08:53:20.900Z" }), {
    userId: "42",
    issuedAt: 1760000000,
  });
});

test("ticketIdentity rejects missing or malformed claims", () => {
  const iat = "2025-10-09T08:53:20Z";
  for (const payload of [
    undefined,
    {},
    { iat },
    { user_id: "", iat },
    { user_id: "0", iat },
    { user_id: "-1", iat },
    { user_id: "7/../../users/me", iat },
    { user_id: "7" },
    { user_id: "7", iat: "not a date" },
  ]) {
    assert.equal(ticketIdentity(payload), null, JSON.stringify(payload));
  }
});

test("fetchDocAccess calls the internal endpoint with the shared secret, not a user token", async () => {
  const { impl, calls } = fakeFetch(200, { role: "contributor", can_edit: true });
  const access = await fetchDocAccess("http://api:8080/api/v1/", identity, "post-12", "s3cret", { fetchImpl: impl });

  assert.deepEqual(access, { role: "contributor", canEdit: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://api:8080/api/v1/internal/users/7/access?doc=post-12&issued_at=1760000000");
  assert.equal(calls[0].init.headers.Authorization, "Bearer s3cret");
});

test("fetchDocAccess forwards the request id as X-Request-ID when given one", async () => {
  const { impl, calls } = fakeFetch(200, { role: "editor" });
  await fetchDocAccess("http://api:8081", identity, "post-12", "s", { fetchImpl: impl, requestId: "req-12345678" });
  assert.equal(calls[0].init.headers["X-Request-ID"], "req-12345678");

  await fetchDocAccess("http://api:8081", identity, "post-12", "s", { fetchImpl: impl });
  assert.ok(!("X-Request-ID" in calls[1].init.headers));
});

test("fetchDocAccess returns null when the user or post is gone or the ticket predates a password change", async () => {
  for (const status of [403, 404]) {
    const { impl } = fakeFetch(status, { error: "nope" });
    assert.equal(await fetchDocAccess("http://api", identity, "post-12", "s", { fetchImpl: impl }), null, `status ${status}`);
  }
});

test("fetchDocAccess throws when the API rejects the shared secret (config error → 503, not 403)", async () => {
  const { impl } = fakeFetch(401, { error: "unauthorized" });
  await assert.rejects(fetchDocAccess("http://api", identity, "post-12", "wrong", { fetchImpl: impl }), /ROLE_LOOKUP_SECRET/);
});

test("fetchDocAccess grants nothing unless the API says can_edit: true", async () => {
  for (const body of [{}, { role: "editor" }, { role: "editor", can_edit: "true" }, { role: "admin", can_edit: 1 }]) {
    const { impl } = fakeFetch(200, body);
    const access = await fetchDocAccess("http://api", identity, "post-12", "s", { fetchImpl: impl });
    assert.equal(access.canEdit, false, JSON.stringify(body));
  }
  const { impl } = fakeFetch(200, { role: "contributor", can_edit: false });
  assert.deepEqual(await fetchDocAccess("http://api", identity, "post-12", "s", { fetchImpl: impl }), {
    role: "contributor",
    canEdit: false,
  });
});

test("fetchDocAccess throws on server errors", async () => {
  const { impl } = fakeFetch(500);
  await assert.rejects(fetchDocAccess("http://api", identity, "post-12", "s", { fetchImpl: impl }), /500/);
});

test("fetchDocAccess throws on network errors", async () => {
  const impl = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(fetchDocAccess("http://api", identity, "post-12", "s", { fetchImpl: impl }), /fetch failed/);
});

test("fetchDocAccess throws when the API doesn't answer in time", async () => {
  // Never resolves on its own; only the abort signal can end it. AbortSignal.timeout's
  // timer is unref'd, so hold a ref'd timer open (a real fetch would hold a socket);
  // otherwise Node can see an empty event loop and cancel the test before the abort.
  const impl = (_url, init) =>
    new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => {}, 10_000);
      init.signal.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(init.signal.reason);
      });
    });
  await assert.rejects(fetchDocAccess("http://api", identity, "post-12", "s", { fetchImpl: impl, timeoutMs: 20 }), {
    name: "TimeoutError",
  });
});

test("verifyTicket rejects a ticket without a jti (it couldn't be burned)", async () => {
  const noJti = await V4.sign(
    { user_id: "7", token_type: TICKET_TYPE, doc: "post-12" },
    privateKey,
    { issuer: ISSUER, audience: TICKET_AUDIENCE, expiresIn: "30s" },
  );
  await assert.rejects(verifyTicket(noJti, publicKey, { issuer: ISSUER, docName: "post-12" }), /no jti/);
});

test("a verified ticket's user_id and iat feed ticketIdentity", async () => {
  const claims = await verifyTicket(await sign(), publicKey, { issuer: ISSUER, docName: "post-12" });
  const id = ticketIdentity(claims);
  assert.equal(id.userId, "7");
  assert.ok(Math.abs(id.issuedAt - Date.now() / 1000) < 5, String(id.issuedAt));
});

test("TicketReplayGuard accepts each jti once", () => {
  const guard = new TicketReplayGuard();
  const exp = new Date(Date.now() + 30_000).toISOString();
  assert.equal(guard.consume({ jti: "a", exp }), true);
  assert.equal(guard.consume({ jti: "a", exp }), false);
  assert.equal(guard.consume({ jti: "b", exp }), true);
});

test("TicketReplayGuard remembers a jti until exp + clock tolerance, then forgets it", () => {
  const guard = new TicketReplayGuard();
  const now = Date.parse("2026-10-20T12:00:00Z");
  const exp = new Date(now + 30_000).toISOString();
  assert.equal(guard.consume({ jti: "a", exp }, now), true);
  // Still inside the window in which verifyTicket would accept it: must stay burned.
  assert.equal(guard.consume({ jti: "a", exp }, now + 30_000 + TICKET_CLOCK_TOLERANCE_MS), false);
  // Past it the ticket can't verify any more, so the entry is pruned (bounded memory).
  guard.consume({ jti: "other", exp: new Date(now + 120_000).toISOString() }, now + 31_000 + TICKET_CLOCK_TOLERANCE_MS);
  assert.equal(guard.size, 1);
});

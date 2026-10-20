import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import { V4 } from "paseto";
import { authorizeUpgrade, canEditContent, fetchCurrentRole, ticketIdentity } from "./access.js";

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

const identity = { userId: "7", issuedAt: 1760000000 };

test("canEditContent allows admin and editor, case-insensitively", () => {
  assert.equal(canEditContent("admin"), true);
  assert.equal(canEditContent("editor"), true);
  assert.equal(canEditContent("Editor"), true);
  assert.equal(canEditContent("ADMIN"), true);
});

test("canEditContent denies contributors and missing roles", () => {
  assert.equal(canEditContent("contributor"), false);
  assert.equal(canEditContent(""), false);
  assert.equal(canEditContent(undefined), false);
  assert.equal(canEditContent(null), false);
  assert.equal(canEditContent(["admin"]), false);
});

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

test("fetchCurrentRole calls the internal endpoint with the shared secret, not a user token", async () => {
  const { impl, calls } = fakeFetch(200, { role: "editor" });
  const role = await fetchCurrentRole("http://api:8080/api/v1/", identity, "s3cret", { fetchImpl: impl });

  assert.equal(role, "editor");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://api:8080/api/v1/internal/users/7/role?issued_at=1760000000");
  assert.equal(calls[0].init.headers.Authorization, "Bearer s3cret");
});

test("fetchCurrentRole returns null when the user is gone or the ticket predates a password change", async () => {
  for (const status of [403, 404]) {
    const { impl } = fakeFetch(status, { error: "nope" });
    assert.equal(await fetchCurrentRole("http://api", identity, "s", { fetchImpl: impl }), null, `status ${status}`);
  }
});

test("fetchCurrentRole throws when the API rejects the shared secret (config error → 503, not 403)", async () => {
  const { impl } = fakeFetch(401, { error: "unauthorized" });
  await assert.rejects(fetchCurrentRole("http://api", identity, "wrong", { fetchImpl: impl }), /ROLE_LOOKUP_SECRET/);
});

test("fetchCurrentRole returns null when the body has no role", async () => {
  const { impl } = fakeFetch(200, {});
  assert.equal(await fetchCurrentRole("http://api", identity, "s", { fetchImpl: impl }), null);
});

test("fetchCurrentRole throws on server errors", async () => {
  const { impl } = fakeFetch(500);
  await assert.rejects(fetchCurrentRole("http://api", identity, "s", { fetchImpl: impl }), /500/);
});

test("fetchCurrentRole throws on network errors", async () => {
  const impl = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(fetchCurrentRole("http://api", identity, "s", { fetchImpl: impl }), /fetch failed/);
});

test("fetchCurrentRole throws when the API doesn't answer in time", async () => {
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
  await assert.rejects(fetchCurrentRole("http://api", identity, "s", { fetchImpl: impl, timeoutMs: 20 }), {
    name: "TimeoutError",
  });
});

// --- authorizeUpgrade with real PASETO v4.public tickets (#223) ---------------------
//
// The point of #223: a WS-only ticket (audience golive.admin-ws ONLY, which the API's
// authMiddleware would reject) must still be authorized, because the role lookup no
// longer forwards the ticket to the API.

const ISSUER = "golive.auth";
const WS_AUDIENCE = "golive.admin-ws";
const privateKey = await V4.generateKey("public");
const publicKey = createPublicKey(privateKey);

/** Signs a ticket the way token/paseto_v4_maker.go does (user_id as a decimal string). */
function signTicket({ audience = WS_AUDIENCE, userId = "7", role = "admin", issuer = ISSUER } = {}) {
  return V4.sign({ user_id: userId, username: "alice", token_type: "access", role }, privateKey, {
    issuer,
    audience,
    subject: "alice",
    expiresIn: "15m",
  });
}

function upgradeOptions(fetchImpl) {
  return {
    publicKey,
    issuer: ISSUER,
    // WS-only: the API audiences (golive.admin, golive.auth) are NOT accepted.
    audiences: [WS_AUDIENCE],
    apiUrl: "http://api:8080/api/v1",
    secret: "role-secret",
    fetchImpl,
  };
}

test("authorizeUpgrade admits an editor holding a golive.admin-ws-only ticket", async () => {
  const ticket = await signTicket({ role: "contributor" }); // stale claim, must be ignored
  const { impl, calls } = fakeFetch(200, { role: "editor" });

  const decision = await authorizeUpgrade(ticket, upgradeOptions(impl));

  assert.equal(decision.ok, true);
  assert.equal(decision.role, "editor");
  assert.equal(decision.audience, WS_AUDIENCE);
  assert.equal(calls.length, 1);
  const iat = Math.floor(Date.parse(decision.payload.iat) / 1000);
  assert.equal(calls[0].url, `http://api:8080/api/v1/internal/users/7/role?issued_at=${iat}`);
  assert.equal(calls[0].init.headers.Authorization, "Bearer role-secret");
  // The ticket itself never goes to the API.
  assert.ok(!JSON.stringify(calls[0]).includes(ticket));
});

test("authorizeUpgrade denies a contributor (DB role) with 403 even if the ticket claims admin", async () => {
  const ticket = await signTicket({ role: "admin" });
  const { impl } = fakeFetch(200, { role: "contributor" });

  const decision = await authorizeUpgrade(ticket, upgradeOptions(impl));

  assert.equal(decision.ok, false);
  assert.equal(decision.status, 403);
});

test("authorizeUpgrade denies with 403 when the API says the user is gone or the ticket is revoked", async () => {
  for (const status of [403, 404]) {
    const ticket = await signTicket();
    const { impl } = fakeFetch(status);
    const decision = await authorizeUpgrade(ticket, upgradeOptions(impl));
    assert.equal(decision.ok, false, `status ${status}`);
    assert.equal(decision.status, 403, `status ${status}`);
  }
});

test("authorizeUpgrade answers 503 when the role lookup fails", async () => {
  const ticket = await signTicket();
  const impl = async () => {
    throw new TypeError("fetch failed");
  };

  const decision = await authorizeUpgrade(ticket, upgradeOptions(impl));

  assert.equal(decision.ok, false);
  assert.equal(decision.status, 503);
});

test("authorizeUpgrade answers 401 for a ticket outside the allowed audiences, without calling the API", async () => {
  const ticket = await signTicket({ audience: "golive.admin" });
  const { impl, calls } = fakeFetch(200, { role: "admin" });

  const decision = await authorizeUpgrade(ticket, upgradeOptions(impl));

  assert.equal(decision.ok, false);
  assert.equal(decision.status, 401);
  assert.equal(calls.length, 0);
});

test("authorizeUpgrade answers 401 for a ticket signed by another key", async () => {
  const otherKey = await V4.generateKey("public");
  const ticket = await V4.sign({ user_id: "7" }, otherKey, {
    issuer: ISSUER,
    audience: WS_AUDIENCE,
    expiresIn: "15m",
  });
  const { impl, calls } = fakeFetch(200, { role: "admin" });

  const decision = await authorizeUpgrade(ticket, upgradeOptions(impl));

  assert.equal(decision.status, 401);
  assert.equal(calls.length, 0);
});

test("authorizeUpgrade denies with 403 a verified ticket without a usable user_id, without calling the API", async () => {
  const ticket = await signTicket({ userId: "not-a-number" });
  const { impl, calls } = fakeFetch(200, { role: "admin" });

  const decision = await authorizeUpgrade(ticket, upgradeOptions(impl));

  assert.equal(decision.status, 403);
  assert.equal(calls.length, 0);
});

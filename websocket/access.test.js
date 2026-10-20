import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import { V4 } from "paseto";
import {
  canEditContent,
  isCollabDocName,
  redeemTicket,
  stripCollabPrefix,
  takeCredential,
  verifyTicket,
  TICKET_AUDIENCE,
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
    { issuer: ISSUER, audience, expiresIn },
  );
}

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

test("redeemTicket POSTs the ticket to /collab/tickets/redeem and returns the current role", async () => {
  const { impl, calls } = fakeFetch(200, {
    user: { id: 7, username: "alice", role: "editor" },
    doc: "post-12",
  });
  const result = await redeemTicket("http://api:8080/api/v1/", "tkt123", { fetchImpl: impl });

  assert.deepEqual(result, { userId: 7, username: "alice", role: "editor", doc: "post-12" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://api:8080/api/v1/collab/tickets/redeem");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer tkt123");
});

test("redeemTicket returns null when the API rejects the ticket or the user is gone", async () => {
  for (const status of [401, 403, 404]) {
    const { impl } = fakeFetch(status, { error: "nope" });
    assert.equal(await redeemTicket("http://api", "t", { fetchImpl: impl }), null, `status ${status}`);
  }
});

test("redeemTicket reports a null role when the body has none", async () => {
  const { impl } = fakeFetch(200, { user: {} });
  assert.equal((await redeemTicket("http://api", "t", { fetchImpl: impl })).role, null);
});

test("redeemTicket throws on server errors", async () => {
  const { impl } = fakeFetch(500);
  await assert.rejects(redeemTicket("http://api", "t", { fetchImpl: impl }), /500/);
});

test("redeemTicket throws on network errors", async () => {
  const impl = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(redeemTicket("http://api", "t", { fetchImpl: impl }), /fetch failed/);
});

test("redeemTicket throws when the API doesn't answer in time", async () => {
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
  await assert.rejects(redeemTicket("http://api", "t", { fetchImpl: impl, timeoutMs: 20 }), {
    name: "TimeoutError",
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canEditContent,
  fetchCurrentRole,
  isCollabDocName,
  stripCollabPrefix,
  takeCredential,
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

test("takeCredential falls back to the legacy ?token= param", () => {
  const req = { url: "/post-12?token=v4.public.SECRET" };
  assert.equal(takeCredential(req), "v4.public.SECRET");
  assert.equal(req.url, "/post-12");
});

test("takeCredential prefers ticket and decodes percent-encoding", () => {
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

test("fetchCurrentRole returns user.role and sends the bearer token to /users/me", async () => {
  const { impl, calls } = fakeFetch(200, { user: { id: 1, role: "editor" } });
  const role = await fetchCurrentRole("http://api:8080/api/v1/", "tok123", { fetchImpl: impl });

  assert.equal(role, "editor");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://api:8080/api/v1/users/me");
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok123");
});

test("fetchCurrentRole returns null when the API rejects the token or the user is gone", async () => {
  for (const status of [401, 403, 404]) {
    const { impl } = fakeFetch(status, { error: "nope" });
    assert.equal(await fetchCurrentRole("http://api", "t", { fetchImpl: impl }), null, `status ${status}`);
  }
});

test("fetchCurrentRole returns null when the body has no role", async () => {
  const { impl } = fakeFetch(200, { user: {} });
  assert.equal(await fetchCurrentRole("http://api", "t", { fetchImpl: impl }), null);
});

test("fetchCurrentRole throws on server errors", async () => {
  const { impl } = fakeFetch(500);
  await assert.rejects(fetchCurrentRole("http://api", "t", { fetchImpl: impl }), /500/);
});

test("fetchCurrentRole throws on network errors", async () => {
  const impl = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(fetchCurrentRole("http://api", "t", { fetchImpl: impl }), /fetch failed/);
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
  await assert.rejects(fetchCurrentRole("http://api", "t", { fetchImpl: impl, timeoutMs: 20 }), {
    name: "TimeoutError",
  });
});

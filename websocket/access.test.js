import { test } from "node:test";
import assert from "node:assert/strict";
import { canEditContent, fetchCurrentRole } from "./access.js";

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
  // Never resolves on its own; only the abort signal can end it.
  const impl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
  await assert.rejects(fetchCurrentRole("http://api", "t", { fetchImpl: impl, timeoutMs: 20 }), {
    name: "TimeoutError",
  });
});

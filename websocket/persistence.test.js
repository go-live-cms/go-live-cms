import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { evaluatePersistedState, hasPendingStructs } from "./persistence.js";

// Use the CJS yjs build — the same single instance persistence.js/server.js use.
// An ESM import here would load the second (ESM) build, and docs created by this test
// would cross instances inside evaluatePersistedState — the exact production bug the
// createRequire pattern guards against (see server.js).
const require = createRequire(import.meta.url);
const Y = require("yjs");

/** Minimal y-leveldb stand-in: getYDoc returns a provided doc; clearDocument noop. */
function fakeLdb(getYDoc) {
  return { getYDoc, clearDocument: async () => {} };
}

/** A doc built from a gapped update log: only the SECOND update is applied. */
function gappedDoc() {
  const src = new Y.Doc();
  const t = src.getText("t");
  t.insert(0, "a");
  const sv1 = Y.encodeStateVector(src);
  t.insert(1, "b");
  const secondUpdate = Y.encodeStateAsUpdate(src, sv1); // depends on the first

  const gapped = new Y.Doc();
  Y.applyUpdate(gapped, secondUpdate); // missing the first update → pending structs
  return gapped;
}

test("clean snapshot → apply, and the update restores the content", async () => {
  const src = new Y.Doc();
  src.getText("t").insert(0, "hello world");
  const snapshot = Y.encodeStateAsUpdate(src);

  const ldb = fakeLdb(async () => {
    const d = new Y.Doc();
    Y.applyUpdate(d, snapshot);
    return d;
  });

  const res = await evaluatePersistedState(ldb, "post-1");
  assert.equal(res.action, "apply");

  const restored = new Y.Doc();
  Y.applyUpdate(restored, res.update);
  assert.equal(restored.getText("t").toString(), "hello world");
});

test("gapped/corrupt snapshot → clear", async () => {
  const gapped = gappedDoc();
  assert.ok(hasPendingStructs(gapped), "precondition: the gapped doc has pending structs");

  const ldb = fakeLdb(async () => gapped);
  const res = await evaluatePersistedState(ldb, "post-1");
  assert.equal(res.action, "clear");
});

test("read failure → skip", async () => {
  const ldb = fakeLdb(async () => {
    throw new Error("leveldb read failed");
  });
  const res = await evaluatePersistedState(ldb, "post-1");
  assert.equal(res.action, "skip");
  assert.ok(res.error instanceof Error);
});

// Documents the Yjs behavior that makes corruption detection reliable: pending /
// gapped structs SURVIVE an encodeStateAsUpdate + applyUpdate round-trip. This is
// why both the original inline probe (check a rebuilt doc) and this module (check
// the source doc) correctly detect a gapped snapshot — they are equivalent.
test("pending structs survive an encode+decode round-trip (probe is reliable)", () => {
  const gapped = gappedDoc();
  const reencoded = new Y.Doc();
  Y.applyUpdate(reencoded, Y.encodeStateAsUpdate(gapped));
  assert.equal(
    hasPendingStructs(reencoded),
    true,
    "re-encoded doc keeps the pending/gapped structs"
  );
});

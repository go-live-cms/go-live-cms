import * as Y from "yjs";

/**
 * Returns true if a Y.Doc has un-integrated ("pending") structs — i.e. it was
 * built from a gapped update log (update N+1 applied without N). Such a doc is
 * corrupt: applying it to a live document poisons the live doc and crashes the
 * next client sync (the classic `integrateStructs` / splice error).
 */
export function hasPendingStructs(ydoc) {
  const store = ydoc.store;
  return (
    store?.pendingStructs != null ||
    (store?.pendingClientsStructRefs?.size ?? 0) > 0
  );
}

/**
 * Reads the persisted state for `docName` from a y-leveldb-style store and decides
 * what to do with it, WITHOUT mutating any live document. The caller applies the
 * returned update (with the persistence origin) or clears the document.
 *
 *   { action: "apply", update }  — clean snapshot, safe to merge into the live doc
 *   { action: "clear" }          — gapped/corrupt, quarantine it (ldb.clearDocument)
 *   { action: "skip", error }    — read failed, continue without persisted state
 *
 * The pending-struct check runs on the doc returned by `getYDoc` directly. (An
 * equivalent check on a doc rebuilt from `Y.encodeStateAsUpdate(persisted)` also
 * works — Yjs preserves pending/gapped structs through encode+decode — but
 * checking the source doc is simpler and avoids an extra round-trip.)
 *
 * This is a behavior-preserving extraction of the inline bindState logic from
 * server.js, made standalone so it can be unit-tested with real Y.Docs.
 */
export async function evaluatePersistedState(ldb, docName) {
  try {
    const persisted = await ldb.getYDoc(docName);

    if (hasPendingStructs(persisted)) {
      if (typeof persisted.destroy === "function") persisted.destroy();
      return { action: "clear" };
    }

    const update = Y.encodeStateAsUpdate(persisted);
    if (typeof persisted.destroy === "function") persisted.destroy();
    return { action: "apply", update };
  } catch (error) {
    return { action: "skip", error };
  }
}

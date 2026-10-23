// The single-yjs-instance probe (#206; the 2026-06 saga's root cause, see
// collab-server/CLAUDE.md). Hocuspocus's Document extends Y.Doc. If this process had
// two yjs builds evaluated (ESM + CJS), Hocuspocus's Document would extend the other
// one's Doc, and cross-instance Y.applyUpdate silently corrupts live docs. main.ts
// exits with status 1 when this returns false.
import * as Y from "yjs"
import { Document } from "@hocuspocus/server"

export function yjsInstanceIsShared(): boolean {
  const probe = new Document("probe")
  try {
    return probe instanceof Y.Doc && probe.getMap("probe") instanceof Y.Map
  } finally {
    probe.destroy()
  }
}

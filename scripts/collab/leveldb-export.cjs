// Child process of leveldb-diff.mjs: dumps every doc of a y-websocket LevelDB store as
// one JSON line {doc, update} on stdout (update: base64 Y.encodeStateAsUpdate, or null
// when the update log is gapped).
//
//   node leveldb-export.cjs <websocket dir> <leveldb dir>
//
// It loads y-leveldb and yjs from websocket/node_modules, both through require(), so
// this process has exactly ONE yjs build (the CJS one y-leveldb uses; see the top gotcha
// in websocket/CLAUDE.md). Only bytes leave it. Point it at a COPY: y-leveldb's getYDoc
// compacts long update logs in place (leveldb-diff.mjs copies the directory first).
"use strict"
const path = require("node:path")
const { createRequire } = require("node:module")

const [websocketDir, dataDir] = process.argv.slice(2)
if (!websocketDir || !dataDir) {
  console.error("usage: node leveldb-export.cjs <websocket dir> <leveldb dir>")
  process.exit(2)
}

const wsRequire = createRequire(path.join(path.resolve(websocketDir), "package.json"))
const Y = wsRequire("yjs")
const { LeveldbPersistence } = wsRequire("y-leveldb")

// Same check as websocket/persistence.js (hasPendingStructs).
const hasPendingStructs = (ydoc) =>
  ydoc.store?.pendingStructs != null || (ydoc.store?.pendingClientsStructRefs?.size ?? 0) > 0

async function main() {
  const ldb = new LeveldbPersistence(path.resolve(dataDir))
  try {
    for (const doc of await ldb.getAllDocNames()) {
      const ydoc = await ldb.getYDoc(doc)
      const update = hasPendingStructs(ydoc) ? null : Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString("base64")
      ydoc.destroy()
      process.stdout.write(JSON.stringify({ doc, update }) + "\n")
    }
  } finally {
    await ldb.destroy()
  }
}

main().catch((error) => {
  console.error(`leveldb-export: ${error?.stack ?? error}`)
  process.exit(1)
})

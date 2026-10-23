// Dry run before the Hocuspocus cutover (#206 P4, #284): for every doc in a y-websocket
// LevelDB store, convert its "default" fragment to a block_doc and compare it with the
// post's block_doc in Postgres. Hocuspocus seeds every doc from block_doc and never
// imports LevelDB, so a doc reported "differs" holds content the cutover would lose.
// Resolve those by opening the post once on the OLD stack (its autosave catches up),
// then run this again. Runbook: docs/operations/collab-cutover.md.
//
// It never writes: it copies the LevelDB directory to a temp dir first (y-leveldb
// compacts long logs when it reads them) and only reads the block_doc file.
//
//   node scripts/collab/leveldb-diff.mjs --data <leveldb dir> --block-docs <posts.json>
//        [--web <web dir>] [--websocket <websocket dir>] [--json <report.json>]
//
// --block-docs: a JSON object keyed by post id, each value the post's block_doc or
//   {block_doc, block_revision?, changed_at?}. Export it with:
//   psql -At -c "select json_object_agg(id, json_build_object('block_doc', block_doc,
//     'block_revision', block_revision, 'changed_at', changed_at)) from posts"
// --web / --websocket: checkouts with node_modules installed (default: ../../web and
//   ../../websocket from this file). The LevelDB reader runs in its own process with
//   websocket's yjs; the comparison runs here with web's, so neither process loads two.
//
// Exit code: 0 nothing to resolve, 1 at least one doc "differs", 2 usage or read error.
import { spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))

function usage(message) {
  if (message) console.error(`leveldb-diff: ${message}`)
  console.error("usage: node scripts/collab/leveldb-diff.mjs --data <leveldb dir> --block-docs <posts.json> [--web <dir>] [--websocket <dir>] [--json <out>]")
  process.exit(2)
}

const args = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]
  const value = process.argv[i + 1]
  if (!key?.startsWith("--") || value === undefined) usage(`bad argument ${key}`)
  args[key.slice(2)] = value
}
const dataDir = args.data
const blockDocsFile = args["block-docs"]
const webDir = path.resolve(args.web ?? path.join(here, "../../web"))
const websocketDir = path.resolve(args.websocket ?? path.join(here, "../../websocket"))
if (!dataDir || !blockDocsFile) usage()
if (!existsSync(dataDir)) usage(`no such directory: ${dataDir}`)

const scratch = mkdtempSync(path.join(tmpdir(), "leveldb-diff-"))
try {
  // 1. LevelDB → {doc, update} lines, from a copy.
  const copy = path.join(scratch, "leveldb")
  cpSync(dataDir, copy, { recursive: true })
  rmSync(path.join(copy, "LOCK"), { force: true })
  const reader = spawnSync(process.execPath, [path.join(here, "leveldb-export.cjs"), websocketDir, copy], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  })
  if (reader.status !== 0) {
    console.error(reader.stderr)
    usage("could not read the LevelDB store")
  }
  const entries = reader.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const { doc, update } = JSON.parse(line)
      return { doc, update: update === null ? null : new Uint8Array(Buffer.from(update, "base64")) }
    })

  // 2. The comparison, bundled from web/ like the collab server (one yjs build).
  const { compareDoc, getCoreSchema } = await loadComparison(webDir, scratch)

  // 3. Postgres block_docs.
  const posts = new Map(
    Object.entries(JSON.parse(readFileSync(blockDocsFile, "utf8")) ?? {}).map(([id, value]) => {
      const wrapped = value && typeof value === "object" && "block_doc" in value
      return [Number(id), wrapped ? value : { block_doc: value }]
    }),
  )

  const schema = getCoreSchema()
  const results = entries.map((entry) => {
    const postId = /^post-(\d+)$/.exec(entry.doc)?.[1]
    const post = postId ? posts.get(Number(postId)) : undefined
    const result = compareDoc(entry, post?.block_doc ?? undefined, schema)
    if (post?.block_revision !== undefined) result.blockRevision = post.block_revision
    if (post?.changed_at !== undefined) result.changedAt = post.changed_at
    return result
  })
  results.sort((a, b) => (a.postId ?? Infinity) - (b.postId ?? Infinity) || a.doc.localeCompare(b.doc))

  report(results)
  if (args.json) writeFileSync(args.json, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2) + "\n")
  process.exit(results.some((r) => r.status === "differs") ? 1 : 0)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

async function loadComparison(webDir, outDir) {
  const webRequire = createRequire(path.join(webDir, "package.json"))
  const esbuild = webRequire("esbuild")
  const outfile = path.join(outDir, "compare.mjs")
  // Same as web/collab-server/build.mjs: every require() of yjs/lib0/y-protocols is
  // resolved like an import, so the bundle holds exactly one yjs build.
  const singleYjsInstance = {
    name: "single-yjs-instance",
    setup(build) {
      build.onResolve({ filter: /^(yjs|lib0|y-protocols)(\/.*)?$/ }, async (a) => {
        if (a.kind === "import-statement" || a.kind === "dynamic-import" || a.pluginData?.pinned) return undefined
        const r = await build.resolve(a.path, { kind: "import-statement", resolveDir: a.resolveDir, importer: a.importer, pluginData: { pinned: true } })
        return r.errors.length > 0 ? { errors: r.errors } : { path: r.path, external: r.external, sideEffects: r.sideEffects }
      })
    },
  }
  await esbuild.build({
    stdin: {
      contents: 'export { compareDoc } from "./collab-server/leveldbDiff"\nexport { getCoreSchema } from "./gl-admin/lib/collaboration/schema"\n',
      resolveDir: webDir,
      loader: "ts",
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    alias: { "@": path.join(webDir, "src"), "@gl-admin": path.join(webDir, "gl-admin"), "@themes": path.join(webDir, "themes") },
    banner: { js: 'import { createRequire as __glCreateRequire } from "node:module"; const require = __glCreateRequire(import.meta.url);' },
    plugins: [singleYjsInstance],
    logLevel: "warning",
  })
  return import(pathToFileURL(outfile).href)
}

function report(results) {
  const counts = {}
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1
  const rows = results.map((r) => [
    r.doc,
    r.status,
    r.leveldbBlocks === undefined ? "" : `${r.leveldbBlocks}/${r.postgresBlocks}`,
    r.blockRevision ?? "",
    [r.firstDifference, r.unconvertible ? `${r.unconvertible} unconvertible node(s)` : ""].filter(Boolean).join("; "),
  ])
  const header = ["doc", "status", "blocks ldb/pg", "revision", "note"]
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => String(row[i]).length)))
  const line = (row) => row.map((cell, i) => String(cell).padEnd(widths[i])).join("  ").trimEnd()
  console.log(line(header))
  for (const row of rows) console.log(line(row))
  console.log("")
  console.log(`${results.length} LevelDB doc(s): ${Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(", ") || "none"}`)
  const differs = results.filter((r) => r.status === "differs")
  if (differs.length > 0) {
    console.log("")
    console.log("RESOLVE BEFORE THE CUTOVER: open each of these posts once on the OLD stack (y-websocket),")
    console.log("wait for \"Saved\", close it, then run this again:")
    for (const r of differs) console.log(`  post ${r.postId}  (/gl-admin/content/edit/${r.postId})`)
  } else {
    console.log("Nothing to resolve: no LevelDB doc holds content that block_doc lacks.")
  }
}

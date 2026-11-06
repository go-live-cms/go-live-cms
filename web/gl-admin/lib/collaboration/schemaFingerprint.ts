import type { MarkType, NodeType, Schema } from "prosemirror-model"

// The schema fingerprint (#416): which editor schema a client binds with, so the collab
// server can refuse an editor tab on a different one (rule 10's "not covered" case).
//
// An editor tab that bound before a deploy keeps its old bundle. When a peer on the new
// bundle inserts a node or mark type the old schema doesn't have, y-tiptap on the old tab
// deletes that element (or text run) from the shared doc for everyone, and the next store
// persists the loss. So every client sends this fingerprint with its ticket in
// Hocuspocus's auth message (never the URL), and the server refuses one that isn't its own
// with `schema-mismatch`; a client that sends none (a bundle from before this guard)
// counts as a mismatch. The refused tab never syncs, so it never receives a type it can't
// build. Shared by the admin bundle and the collab server, which compute it the same way
// (`schema.test.ts` proves the two schemas, and so the two fingerprints, are equal).
//
// Must NOT import yjs (the collab server's auth.ts imports this) or anything with a DOM.

/** Bumped if the description below changes shape, so old and new never compare equal. */
const FORMAT = "golive-schema/1"

/**
 * The parts of a schema that decide which documents it can build, as canonical JSON. Two
 * schemas get the same description exactly when ProseMirror (and so y-tiptap) treats them
 * as accepting the same documents with the same attributes.
 *
 * What counts:
 * - the top node's name;
 * - every node type, **in schema order**: its name, content expression (as ProseMirror's
 *   own tokenizer splits it, so whitespace doesn't matter but the order of alternatives
 *   does: the first one is what `createAndFill` uses), groups, whether it is inline, the
 *   marks it allows (resolved to mark names), and its attributes;
 * - every mark type, **in schema order** (that order is the mark rank: it decides how marks
 *   on a text node are sorted): its name, the marks it excludes (resolved), and its
 *   attributes;
 * - an attribute is its name, its default (canonical JSON; `undefined` apart from `null`)
 *   or that it has none (required), and its `validate` string if it has one.
 *
 * What doesn't (ProseMirror treats these as equal, or they only change editing, parsing or
 * rendering, not which documents can be built):
 * - the order of attributes within a node or mark, of keys within a spec or a default
 *   value, of groups in `group`, of names in a node's `marks` or a mark's `excludes`;
 * - `atom`, `selectable`, `draggable`, `defining`, `isolating`, `code`, `whitespace`,
 *   `inclusive`, `spanning`, `parseDOM`, `toDOM`, `leafText` and any custom spec key (a theme
 *   block's `glThemeBlock` spec reaches the schema as its node's attributes).
 *
 * Reordering node or mark types does change it: ProseMirror gives that order a meaning.
 */
export function describeSchemaForFingerprint(schema: Schema): string {
  const nodes = Object.values(schema.nodes).map((type) => [
    type.name,
    {
      content: contentTokens(type.spec.content ?? ""),
      group: words(type.spec.group),
      inline: type.isInline,
      marks: allowedMarks(type),
      attrs: attributes(type.spec.attrs),
    },
  ])
  const marks = Object.values(schema.marks).map((type) => [
    type.name,
    {
      excludes: excludedMarks(type),
      attrs: attributes(type.spec.attrs),
    },
  ])
  return canonicalJSON([FORMAT, schema.topNodeType.name, nodes, marks])
}

const fingerprints = new WeakMap<Schema, string>()

/** SHA-256 (hex) of `describeSchemaForFingerprint`. Cached per schema (schemas are immutable). */
export function schemaFingerprint(schema: Schema): string {
  let fingerprint = fingerprints.get(schema)
  if (!fingerprint) {
    fingerprint = sha256Hex(describeSchemaForFingerprint(schema))
    fingerprints.set(schema, fingerprint)
  }
  return fingerprint
}

/** What a well-formed fingerprint looks like (anything else is logged as "invalid"). */
export const SCHEMA_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/

/** What the client sends as Hocuspocus's auth token. */
export interface CollabAuthToken {
  /** The single-use collab ticket (POST /collab/tickets); "" if none. */
  ticket: string
  /** The client's schema fingerprint; null if it sent none (a client from before #416). */
  schema: string | null
}

/**
 * The auth token for Hocuspocus's auth message: the ticket and the schema fingerprint as
 * JSON. Hocuspocus's provider sends one string there, and the URL is not an option (proxy
 * logs would see the ticket, #233).
 */
export function encodeCollabAuthToken(ticket: string, schema: string): string {
  return JSON.stringify({ ticket, schema })
}

/**
 * The server's reading of an auth token. A bare ticket (what clients sent before #416: a
 * PASETO token, never JSON) is a ticket with no fingerprint; malformed JSON is neither.
 */
export function decodeCollabAuthToken(token: unknown): CollabAuthToken {
  if (typeof token !== "string") return { ticket: "", schema: null }
  const trimmed = token.trim()
  if (!trimmed.startsWith("{")) return { ticket: trimmed, schema: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ticket: "", schema: null }
  }
  const { ticket, schema } = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>
  return {
    ticket: typeof ticket === "string" ? ticket.trim() : "",
    schema: typeof schema === "string" && schema ? schema : null,
  }
}

// ProseMirror's content expression tokenizer (prosemirror-model's TokenStream).
function contentTokens(expression: string): string[] {
  const tokens = expression.split(/\s*(?=\b|\W|$)/)
  if (tokens[tokens.length - 1] === "") tokens.pop()
  if (tokens[0] === "") tokens.shift()
  return tokens
}

const words = (value: string | undefined): string[] => (value ?? "").split(/\s+/).filter(Boolean).sort()

const names = (types: readonly (MarkType | NodeType)[]): string[] => types.map((type) => type.name).sort()

/** "_" for every mark; else the allowed marks' names (groups resolved). */
const allowedMarks = (type: NodeType): string | string[] => (type.markSet === null ? "_" : names(type.markSet))

/**
 * The marks this one excludes (itself, by default), groups resolved. `excluded` is
 * ProseMirror's resolved list (not in its public types); fail loudly if it ever goes, or
 * every excludes change would stop counting.
 */
function excludedMarks(type: MarkType): string[] {
  const excluded = (type as unknown as { excluded?: unknown }).excluded
  if (!Array.isArray(excluded)) throw new Error(`schemaFingerprint: MarkType.excluded is missing on "${type.name}" (prosemirror-model changed)`)
  return names(excluded as MarkType[])
}

type AttrSpecs = Record<string, { default?: unknown; validate?: unknown }> | undefined

function attributes(specs: AttrSpecs) {
  return Object.keys(specs ?? {})
    .sort()
    .map((name) => {
      const spec = specs![name] ?? {}
      // JSON has no undefined; `default: undefined` is a default of its own (the attr's
      // value is undefined, not null), so it gets its own marker.
      const attr: Record<string, unknown> = !Object.prototype.hasOwnProperty.call(spec, "default")
        ? { required: true }
        : spec.default === undefined
          ? { defaultUndefined: true }
          : { default: spec.default }
      if (typeof spec.validate === "string") attr.validate = spec.validate
      return [name, attr]
    })
}

/** JSON with object keys sorted at every depth (so key order never matters). */
function canonicalJSON(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.keys(inner as object).sort().map((key) => [key, (inner as Record<string, unknown>)[key]]))
      : inner,
  )
}

// SHA-256 in plain JS, synchronous, the same in the browser and in Node: Web Crypto's
// digest is async and missing outside secure contexts (a dev admin on a LAN address), and
// node:crypto isn't in the browser. Not a security boundary (a client can send any
// fingerprint it likes); it only has to tell two schemas apart. Checked against node:crypto
// in schemaFingerprint.test.ts.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  const bits = bytes.length * 8
  view.setUint32(padded.length - 8, Math.floor(bits / 0x1_0000_0000))
  view.setUint32(padded.length - 4, bits >>> 0)

  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = hash
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    hash[0] += a
    hash[1] += b
    hash[2] += c
    hash[3] += d
    hash[4] += e
    hash[5] += f
    hash[6] += g
    hash[7] += h
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("")
}

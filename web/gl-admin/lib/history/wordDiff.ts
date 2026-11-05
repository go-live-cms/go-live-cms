// Word-level text diff for History's "Highlight changes" (#355). Pure and import-free, so
// it runs in the diff worker (blockDiff.worker.ts) as well as on the main thread.
//
// Text is split into word, whitespace and punctuation tokens; each token keeps the marks
// (bold, link, ...) of the run it came from, and two tokens are equal only when their text
// AND marks are, so making a word bold shows as a change. The token sequences are compared
// with Myers' O(ND) algorithm, capped so a block rewritten from scratch costs a bounded
// amount of work (then it's shown as all removed + all added).

export interface Mark {
  type: string
  attrs?: Record<string, unknown>
}

/**
 * One token of a block's text. `kind` "break" is a hard line break, "para" the boundary
 * between two paragraphs of the same block (a quote's, a list item's), "node" an inline
 * node other than text (a theme's inline node; `text` is its type).
 */
export interface Token {
  text: string
  marks?: Mark[]
  kind?: "break" | "para" | "node"
  key: string
}

/**
 * A run of tokens with one origin and one set of marks. "same": in both documents;
 * "version": only in the version being viewed; "working": only in the working copy.
 */
export type SegmentOp = "same" | "version" | "working"

export interface Segment {
  op: SegmentOp
  text: string
  marks?: Mark[]
  kind?: "break" | "para" | "node"
}

// Words (letters, digits, marks, joined by ' ’ or -), runs of whitespace, single CJK
// characters (no spaces between words there), and any other single character.
const TOKEN_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}\p{M}_]+(?:['’-][\p{L}\p{N}\p{M}_]+)*|\s+|[^\s]/gu

function marksKey(marks: Mark[] | undefined): string {
  if (!marks || marks.length === 0) return ""
  return marks
    .map((m) => (m.attrs && Object.keys(m.attrs).length > 0 ? `${m.type}${stableJson(m.attrs)}` : m.type))
    .sort()
    .join("|")
}

/** JSON with sorted keys, so two equal objects always give the same string. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
    .join(",")}}`
}

/** Splits a text run into tokens carrying `marks`. */
export function tokenize(text: string, marks?: Mark[]): Token[] {
  const m = marks && marks.length > 0 ? marks : undefined
  const mk = marksKey(m)
  const out: Token[] = []
  for (const match of text.matchAll(TOKEN_RE)) {
    out.push(m ? { text: match[0], marks: m, key: `${match[0]}\u0001${mk}` } : { text: match[0], key: match[0] })
  }
  return out
}

export const breakToken = (): Token => ({ text: "\n", kind: "break", key: "\u0000break" })
export const paraToken = (): Token => ({ text: "\n\n", kind: "para", key: "\u0000para" })

/** A ProseMirror JSON node, as stored in a block's `attrs.pm`. */
export interface PMJson {
  type?: string
  text?: string
  marks?: Mark[]
  attrs?: Record<string, unknown>
  content?: PMJson[]
}

/**
 * The tokens of ProseMirror content: text runs, hard breaks, and a "para" token between
 * nested blocks (a quote's paragraphs). `skip` leaves some child nodes out (a list item's
 * nested lists, diffed on their own).
 */
export function contentTokens(content: PMJson[] | undefined, skip?: (node: PMJson) => boolean): Token[] {
  const out: Token[] = []
  const walk = (nodes: PMJson[] | undefined, depth: number) => {
    if (!Array.isArray(nodes)) return
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue
      if (depth === 0 && skip?.(node)) continue
      if (node.type === "text") {
        if (typeof node.text === "string" && node.text !== "") out.push(...tokenize(node.text, node.marks))
      } else if (node.type === "hardBreak") {
        out.push(breakToken())
      } else if (Array.isArray(node.content) || isTextblockType(node.type)) {
        // A nested block: a paragraph boundary before it, unless it's the first.
        if (out.length > 0 && out[out.length - 1].kind !== "para") out.push(paraToken())
        walk(node.content, depth + 1)
      } else {
        // Another inline leaf (a theme's inline node): no text of its own, but a change to it
        // is a change, so it's a token of its own (shown by its type).
        out.push({
          text: String(node.type ?? "element"),
          kind: "node",
          key: `\u0000node:${node.type}:${stableJson(node.attrs ?? {})}`,
        })
      }
    }
  }
  walk(content, 0)
  // A trailing paragraph boundary (an empty last paragraph) shows nothing.
  while (out.length > 0 && out[out.length - 1].kind === "para") out.pop()
  return out
}

function isTextblockType(type: string | undefined): boolean {
  return type === "paragraph" || type === "heading" || type === "codeBlock"
}

type Op = "=" | "+" | "-"

/**
 * Myers' shortest edit script from `a` (working copy) to `b` (version), as one op per
 * token: "=" in both, "-" only in `a`, "+" only in `b`. Null when more than `maxD` edits
 * are needed. Keeps only the band [-d, d] of each step's V array, so memory is O(D²).
 */
function myers(a: string[], b: string[], maxD: number): Op[] | null {
  const n = a.length
  const m = b.length
  const max = n + m
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  const limit = Math.min(max, maxD)
  for (let d = 0; d <= limit; d++) {
    // V as it was after step d-1, for k in [-d-1, d+1] (index k + d + 1).
    trace.push(v.slice(off - d - 1, off + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) return backtrack(trace, d, n, m)
    }
  }
  return null
}

function backtrack(trace: Int32Array[], dEnd: number, n: number, m: number): Op[] {
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = dEnd; d > 0; d--) {
    const vd = trace[d]
    const get = (k: number) => vd[k + d + 1]
    const k = x - y
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1
    const prevX = get(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push("=")
      x--
      y--
    }
    if (x === prevX) {
      ops.push("+")
      y--
    } else {
      ops.push("-")
      x--
    }
  }
  while (x > 0 && y > 0) {
    ops.push("=")
    x--
    y--
  }
  return ops.reverse()
}

/** Above this many edits a text counts as rewritten: all removed, all added. */
export const MAX_EDITS = 1000

/**
 * The word diff of a block's text, as segments in reading order. Unchanged text keeps the
 * version's tokens. Where text differs, the version's run comes first, then the working
 * copy's (History · 1 shows the version, so its words lead). A whitespace-only gap between
 * two changes joins them, so "the quick" → "a slow" reads as one replaced phrase, not
 * alternating fragments.
 */
export function diffTokens(working: Token[], version: Token[], maxEdits = MAX_EDITS): Segment[] {
  let start = 0
  while (start < working.length && start < version.length && working[start].key === version[start].key) start++
  let endW = working.length
  let endV = version.length
  while (endW > start && endV > start && working[endW - 1].key === version[endV - 1].key) {
    endW--
    endV--
  }

  const midW = working.slice(start, endW)
  const midV = version.slice(start, endV)
  let ops =
    midW.length === 0 || midV.length === 0
      ? [...midW.map((): Op => "-"), ...midV.map((): Op => "+")]
      : myers(
          midW.map((t) => t.key),
          midV.map((t) => t.key),
          maxEdits
        )
  if (!ops) ops = [...midW.map((): Op => "-"), ...midV.map((): Op => "+")]

  // Pair each op with its token: [op, working token | null, version token | null].
  type Step = { op: Op; w?: Token; v?: Token }
  const steps: Step[] = []
  for (let i = 0; i < start; i++) steps.push({ op: "=", v: version[i] })
  let iw = 0
  let iv = 0
  for (const op of ops) {
    if (op === "=") steps.push({ op, v: midV[iv++], w: midW[iw++] })
    else if (op === "-") steps.push({ op, w: midW[iw++] })
    else steps.push({ op, v: midV[iv++] })
  }
  for (let i = endV; i < version.length; i++) steps.push({ op: "=", v: version[i] })

  // Group into runs: equal runs, and change runs (adjacent + and - ops).
  type Run = { equal: true; tokens: Token[] } | { equal: false; version: Token[]; working: Token[] }
  const runs: Run[] = []
  for (const step of steps) {
    const last = runs[runs.length - 1]
    if (step.op === "=") {
      if (last?.equal) last.tokens.push(step.v!)
      else runs.push({ equal: true, tokens: [step.v!] })
    } else {
      const change =
        last && !last.equal
          ? last
          : (runs[runs.push({ equal: false, version: [], working: [] }) - 1] as Run & { equal: false })
      if (step.op === "+") change.version.push(step.v!)
      else change.working.push(step.w!)
    }
  }

  // Join two changes separated only by whitespace.
  const merged: Run[] = []
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]
    const prev = merged[merged.length - 1]
    const next = runs[i + 1]
    if (
      run.equal &&
      prev &&
      !prev.equal &&
      next &&
      !next.equal &&
      run.tokens.every((t) => !t.kind && /^\s+$/.test(t.text))
    ) {
      prev.version.push(...run.tokens, ...next.version)
      prev.working.push(...run.tokens, ...next.working)
      i++
      continue
    }
    if (!run.equal && prev && !prev.equal) {
      prev.version.push(...run.version)
      prev.working.push(...run.working)
      continue
    }
    merged.push(
      run.equal
        ? { equal: true, tokens: [...run.tokens] }
        : { equal: false, version: [...run.version], working: [...run.working] }
    )
  }

  const out: Segment[] = []
  const emit = (op: SegmentOp, tokens: Token[]) => {
    for (const t of tokens) {
      if (t.text === "") continue
      const last = out[out.length - 1]
      if (last && last.op === op && !last.kind && !t.kind && marksKey(last.marks) === marksKey(t.marks)) {
        last.text += t.text
      } else {
        out.push({ op, text: t.text, ...(t.marks ? { marks: t.marks } : {}), ...(t.kind ? { kind: t.kind } : {}) })
      }
    }
  }
  for (const run of merged) {
    if (run.equal) emit("same", run.tokens)
    else {
      emit("version", run.version)
      emit("working", run.working)
    }
  }
  return out
}

/** Whether any segment differs between the two documents. */
export function hasChanges(segments: Segment[]): boolean {
  return segments.some((s) => s.op !== "same")
}

/** Plain-text word diff (settings fields: title, excerpt, SEO). */
export function diffText(working: string, version: string): Segment[] {
  return diffTokens(tokenize(working), tokenize(version))
}

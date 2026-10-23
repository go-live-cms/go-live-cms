// Ported from websocket/log-guard.test.js (#220, #254): no module of the collab server
// may log a ticket, a secret, or a request/socket (which carry headers). Scans source:
// every log call (console.* / console[level] / logEvent / process.std{out,err}.write)
// in every non-test .ts file here must not reference those, and console methods may not
// be aliased or passed around (which would hide a log call from this scan).
//
// Defence in depth only: values laundered through an innocently named variable still
// pass. The real guarantee is that the ticket is only ever held by auth.ts.
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DIR = path.dirname(fileURLToPath(import.meta.url))
const FILES = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "testkit.ts")
  .map((f) => path.join(DIR, f))

// Identifiers that would put a credential (or a container of one) into a log line.
const FORBIDDEN = [
  /\breq(uest)?\b/, // a request (its url, headers, or the whole object)
  /\brequestHeaders\b/,
  /\bheaders\b/,
  /\bsocket\b/,
  /\bsearchParams\b/,
  /\brequestParameters\b/,
  /\bcredential\b/,
  /\btoken\b/,
  /\bticket\b/,
  /\bsecret\b/i,
  /\bpayload\b(?!\.documentName\b)/, // the whole auth payload (it holds the token)
  /\bparams\b/,
  /\bbody\b(?!\.state\.length\b)/, // a store body is a whole document
  /(^|[^\w.$])url\b/, // a parsed URL object (not apiUrl / x.url)
]

// The logsafe.ts views may take a request's headers; their output is what's allowed.
const SANITIZER_CALL = /\b(clientContextForLog|docNameForLog)\s*\([^()]*(\([^()]*\)[^()]*)*\)/g

const LOG_CALL = /\b(console\s*(\.\s*\w+|\[[^\]]*\])|logEvent|process\.std(out|err)\.write)\s*\(/g
const CONSOLE_ALIAS = /\bconsole\b(?!\s*(\.\s*\w+|\[[^\]]*\])\s*\()/g

const REGEX_PREFIX_CHARS = new Set("(,=:[!&|?{};+-*%<>~^")
const REGEX_PREFIX_KEYWORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw",
  "case", "do", "else", "yield", "await"])

/**
 * `src` with comments removed and string / regex literal contents replaced by spaces,
 * keeping template ${…} expressions and every newline (so offsets keep line numbers).
 */
function blankLiterals(src: string): string {
  let out = ""
  const stack: ({ kind: "code"; braces: number } | { kind: "str"; quote: string })[] = [{ kind: "code", braces: 0 }]
  const blank = (s: string) => s.replace(/[^\n]/g, " ")
  let prevSig = ""
  let prevWord = ""
  const emit = (s: string) => {
    out += s
    for (const ch of s) {
      if (/\s/.test(ch)) continue
      prevWord = /[\w$]/.test(ch) ? (/[\w$]/.test(prevSig) ? prevWord : "") + ch : ""
      prevSig = ch
    }
  }
  const regexAllowed = () => prevSig === "" || REGEX_PREFIX_CHARS.has(prevSig) || REGEX_PREFIX_KEYWORDS.has(prevWord)
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const next = src[i + 1]
    const top = stack[stack.length - 1]

    if (top.kind === "str") {
      if (c === "\\") {
        out += " " + blank(next ?? "")
        i++
        continue
      }
      if (c === top.quote) {
        stack.pop()
        emit(c)
        continue
      }
      if (top.quote === "`" && c === "$" && next === "{") {
        stack.push({ kind: "code", braces: 0 })
        emit("${")
        i++
        continue
      }
      out += blank(c)
      continue
    }

    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i)
      const stop = end === -1 ? src.length : end
      out += blank(src.slice(i, stop))
      i = stop - 1
      continue
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2)
      const stop = end === -1 ? src.length : end + 2
      out += blank(src.slice(i, stop))
      i = stop - 1
      continue
    }
    if (c === "/" && regexAllowed()) {
      let j = i + 1
      let inClass = false
      for (; j < src.length && src[j] !== "\n"; j++) {
        if (src[j] === "\\") {
          j++
          continue
        }
        if (src[j] === "[") inClass = true
        else if (src[j] === "]") inClass = false
        else if (src[j] === "/" && !inClass) break
      }
      out += "/" + blank(src.slice(i + 1, j))
      emit("/")
      prevSig = ")"
      i = j
      continue
    }
    if (c === "'" || c === '"' || c === "`") {
      stack.push({ kind: "str", quote: c })
      emit(c)
      continue
    }
    if (c === "{") top.braces++
    if (c === "}") {
      if (stack.length > 1 && top.braces === 0) {
        stack.pop()
        emit(c)
        continue
      }
      top.braces--
    }
    emit(c)
  }
  return out
}

const lineOf = (src: string, index: number) => src.slice(0, index).split("\n").length

function logCallArgs(src: string) {
  const code = blankLiterals(src)
  const calls: { line: number; code: string }[] = []
  for (const m of code.matchAll(LOG_CALL)) {
    let depth = 1
    let i = m.index! + m[0].length
    const startArgs = i
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === "(") depth++
      else if (code[i] === ")") depth--
    }
    calls.push({ line: lineOf(code, m.index!), code: code.slice(startArgs, i - 1) })
  }
  return calls
}

const consoleAliases = (src: string) => {
  const code = blankLiterals(src)
  return [...code.matchAll(CONSOLE_ALIAS)].map((m) => lineOf(code, m.index!))
}

const offenders = (src: string) =>
  logCallArgs(src).filter(({ code }) => {
    const unsanitized = code.replace(SANITIZER_CALL, "SAFE")
    return FORBIDDEN.some((re) => re.test(unsanitized))
  })

describe("log guard scanner", () => {
  it("ignores message text in strings and comments", () => {
    expect(offenders('console.log("token ticket secret req.url", \'params\') // ticket')).toEqual([])
  })

  it("sees template expressions, including nested braces", () => {
    expect(offenders("console.log(`ctx ${fmt({ a: 1 })} ${ticket}`);")).toHaveLength(1)
    expect(offenders("console.log(`${`${request.headers}`}`);")).toHaveLength(1)
  })

  it("covers logEvent fields, console[level] and stdout writes", () => {
    expect(offenders('logEvent("info", "x", { t: payload.token })')).toHaveLength(1)
    expect(offenders('logEvent("warn", "x", { ticket })')).toHaveLength(1)
    expect(offenders('logEvent("warn", "x", { h: requestHeaders })')).toHaveLength(1)
    expect(offenders("console[level](roleLookupSecret)")).toHaveLength(0) // a renamed value slips past: see the header
    expect(offenders("console[level](secret)")).toHaveLength(1)
    expect(offenders("process.stderr.write(credential)")).toHaveLength(1)
    expect(offenders('logEvent("error", "x", { b: body })')).toHaveLength(1)
  })

  it("allows the logsafe views and safe fields", () => {
    expect(offenders('logEvent("warn", "ws_deny", { client: clientContextForLog(payload.requestHeaders, payload.request?.socket?.remoteAddress) })')).toEqual([])
    expect(offenders('logEvent("info", "collab_store", { doc: docNameForLog(documentName), bytes: body.state.length })')).toEqual([])
  })

  it("reports console aliasing", () => {
    expect(consoleAliases("const log = console.log")).toHaveLength(1)
    expect(consoleAliases("[1].forEach(console.log)")).toHaveLength(1)
    expect(consoleAliases('console.log("console"); console[level](x)')).toEqual([])
  })
})

describe.each(FILES.map((file) => [path.basename(file), file]))("%s", (name, file) => {
  const src = fs.readFileSync(file, "utf8")

  it("never logs a ticket, secret, request, socket or store body", () => {
    expect(offenders(src).map(({ line, code }) => `${name}:${line}: ${code.replace(/\s+/g, " ").trim()}`)).toEqual([])
  })

  it("doesn't alias or pass around console methods", () => {
    expect(consoleAliases(src).map((l) => `${name}:${l}`)).toEqual([])
  })
})

it("the guard found log calls to check", () => {
  const total = FILES.reduce((n, f) => n + logCallArgs(fs.readFileSync(f, "utf8")).length, 0)
  expect(total).toBeGreaterThan(15)
})

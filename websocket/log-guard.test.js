// Regression guard for #220: no module may log the raw upgrade request or the
// credential, because the access token rides in the upgrade URL. server.js boots the
// server on import, so this scans source instead of running it. Every log call
// (console.* / console[level] / collabDebug / process.std{out,err}.write) in every
// non-test .js file here must not reference the request URL, headers, query params or
// credential, and console methods may not be aliased or passed around (which would hide
// a log call from this scan).
//
// Defence in depth only: takeCredential (access.js) strips the token from req.url before
// anything reads it. Values laundered through an innocently named variable still pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
// LOG_GUARD_FILES=a.js,b.js scans specific files (e.g. an old revision) instead.
const FILES = process.env.LOG_GUARD_FILES
  ? process.env.LOG_GUARD_FILES.split(",")
  : fs.readdirSync(DIR).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js")).map((f) => path.join(DIR, f));

// Identifiers that would put the token (or a container of it) into a log line.
const FORBIDDEN = [
  /\breq\b(?!\.auth\b)/, // the request (its url, headers, or the whole object); req.auth is the verified identity
  /\bsocket\b/,
  /\bsearchParams\b/,
  /\bcredential\b/,
  /\btoken\b/,
  /\bparams\b/,
  /(^|[^\w.$])url\b/, // a parsed URL object (not API_URL / x.url)
];

// The logsafe.js views may take req; their output is what's allowed in logs.
const SANITIZER_CALL = /\b(upgradeContextForLog|docNameForLog)\s*\([^()]*\)/g;

const LOG_CALL = /\b(console\s*(\.\s*\w+|\[[^\]]*\])|collabDebug|process\.std(out|err)\.write)\s*\(/g;
// `console` used as anything but an immediate method call: `const log = console.log`,
// `.forEach(console.log)`, `.bind(console)`, `const c = console`.
const CONSOLE_ALIAS = /\bconsole\b(?!\s*(\.\s*\w+|\[[^\]]*\])\s*\()/g;

// A `/` starts a regex literal (rather than a division) after one of these characters,
// after one of these keywords, or at the start of the file. After `)`, `]`, `}`, an
// identifier or a literal it's a division. (A regex starting a statement right after a
// `}` is misread as division; nothing here writes that.)
const REGEX_PREFIX_CHARS = new Set("(,=:[!&|?{};+-*%<>~^");
const REGEX_PREFIX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw",
  "case", "do", "else", "yield", "await",
]);

/**
 * Returns `src` with comments removed and string / regex literal contents replaced by
 * spaces, keeping template ${…} expressions (so `${req.url}` is still visible) and every
 * newline (so offsets map to the same line numbers).
 */
function blankLiterals(src) {
  let out = "";
  const stack = [{ kind: "code", braces: 0 }];
  const blank = (s) => s.replace(/[^\n]/g, " ");
  // Last non-whitespace code character emitted, and the identifier ending at it (if
  // any): enough to tell a regex literal from a division without rescanning `out`.
  let prevSig = "";
  let prevWord = "";
  const emit = (s) => {
    out += s;
    for (const ch of s) {
      if (/\s/.test(ch)) continue;
      prevWord = /[\w$]/.test(ch) ? (/[\w$]/.test(prevSig) ? prevWord : "") + ch : "";
      prevSig = ch;
    }
  };
  const regexAllowed = () =>
    prevSig === "" || REGEX_PREFIX_CHARS.has(prevSig) || REGEX_PREFIX_KEYWORDS.has(prevWord);
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    const top = stack[stack.length - 1];

    if (top.kind === "str") {
      if (c === "\\") { out += " " + blank(next ?? ""); i++; continue; }
      if (c === top.quote) { stack.pop(); emit(c); continue; }
      if (top.quote === "`" && c === "$" && next === "{") {
        stack.push({ kind: "code", braces: 0 });
        emit("${");
        i++;
        continue;
      }
      out += blank(c);
      continue;
    }

    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      out += blank(src.slice(i, stop));
      i = stop - 1;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += blank(src.slice(i, stop));
      i = stop - 1;
      continue;
    }
    if (c === "/" && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      for (; j < src.length && src[j] !== "\n"; j++) {
        if (src[j] === "\\") { j++; continue; }
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
      }
      out += "/" + blank(src.slice(i + 1, j));
      emit("/"); // closing slash; a regex is a value, so a following `/` divides
      prevSig = ")";
      i = j;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { stack.push({ kind: "str", quote: c }); emit(c); continue; }
    if (c === "{") top.braces++;
    if (c === "}") {
      if (stack.length > 1 && top.braces === 0) { stack.pop(); emit(c); continue; } // end of ${…}
      top.braces--;
    }
    emit(c);
  }
  return out;
}

const lineOf = (src, index) => src.slice(0, index).split("\n").length;

/** The argument code (literals blanked) of every log call in `src`. */
function logCallArgs(src) {
  const code = blankLiterals(src);
  const calls = [];
  for (const m of code.matchAll(LOG_CALL)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const startArgs = i;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")") depth--;
    }
    calls.push({ line: lineOf(code, m.index), code: code.slice(startArgs, i - 1) });
  }
  return calls;
}

function consoleAliases(src) {
  const code = blankLiterals(src);
  return [...code.matchAll(CONSOLE_ALIAS)].map((m) => lineOf(code, m.index));
}

const offenders = (src) =>
  logCallArgs(src).filter(({ code }) => {
    const unsanitized = code.replace(SANITIZER_CALL, "SAFE");
    return FORBIDDEN.some((re) => re.test(unsanitized));
  });

test("scanner ignores message text in strings", () => {
  assert.deepEqual(offenders('console.log("token url credential req.url", \'params\');'), []);
});

test("scanner sees template expressions, including nested braces", () => {
  assert.equal(offenders("console.log(`ctx ${fmt({ a: 1 })} ${req.url}`);").length, 1);
  assert.equal(offenders("console.log(`${`${req.headers}`}`);").length, 1);
});

test("scanner isn't fooled by apostrophes in comments or quotes in regexes", () => {
  assert.equal(offenders("console.log(\n  // don't log this\n  req.url,\n);").length, 1);
  assert.equal(offenders("console.log(/* it's */ credential);").length, 1);
  assert.equal(offenders("const q = /'/; console.log(req.url); const r = /\"/;").length, 1);
});

test("scanner treats a / after return, typeof etc. as a regex, and after values as division", () => {
  assert.equal(offenders("function q(s) { return /'/.test(s) }\nconsole.log(req.url);").length, 1);
  assert.equal(offenders("const t = typeof /\"/;\nconsole.log(credential);").length, 1);
  // Divisions must not be read as regexes (which would swallow the code up to the next /).
  assert.equal(offenders("const a = n / 2; const b = (n) / 3; console.log(req.url); const c = x / 4;").length, 1);
  assert.equal(offenders("const r = /a/ / 2; console.log(token);").length, 1);
});

test("scanner flags logging the whole request or socket, but allows the logsafe views", () => {
  assert.equal(offenders("console.log(req);").length, 1);
  assert.equal(offenders("console.dir({ req }, { depth: 1 });").length, 1);
  assert.equal(offenders("console.log(socket);").length, 1);
  assert.deepEqual(offenders("console.log(req.auth?.username, req.auth.role);"), []);
  assert.deepEqual(offenders("console.warn(`x ${upgradeContextForLog(req)} ${docNameForLog(name)}`);"), []);
  // A sanitizer wrapping something else doesn't launder a raw req alongside it.
  assert.equal(offenders("console.log(upgradeContextForLog(req), req.headers);").length, 1);
});

test("scanner covers console[level], other console methods and stdout writes", () => {
  assert.equal(offenders("console[level](`x ${req.url}`);").length, 1);
  assert.equal(offenders("console.dir(url.searchParams);").length, 1);
  assert.equal(offenders("process.stderr.write(credential);").length, 1);
});

test("scanner reports console aliasing", () => {
  assert.equal(consoleAliases("const log = console.log;").length, 1);
  assert.equal(consoleAliases("[1].forEach(console.log);").length, 1);
  assert.equal(consoleAliases("fn.bind(console);").length, 1);
  assert.deepEqual(consoleAliases('console.log("console"); console[level](x);'), []);
});

for (const file of FILES) {
  const name = path.basename(file);

  test(`${name} never logs the request URL, headers, query params or credential`, () => {
    const src = fs.readFileSync(file, "utf8");
    assert.deepEqual(
      offenders(src).map(({ line, code }) => `${name}:${line}: ${code.replace(/\s+/g, " ").trim()}`),
      [],
      "log only docNameForLog / upgradeContextForLog from logsafe.js (#220)",
    );
  });

  test(`${name} doesn't alias or pass around console methods`, () => {
    const lines = consoleAliases(fs.readFileSync(file, "utf8"));
    assert.deepEqual(lines.map((l) => `${name}:${l}`), [], "call console.* directly so the guard can see it");
  });
}

test("the guard actually found log calls to check", () => {
  const total = FILES.reduce((n, f) => n + logCallArgs(fs.readFileSync(f, "utf8")).length, 0);
  assert.ok(total > 20, `expected to find log calls, found ${total}`);
});

// Regression guard for #220: server.js must never log the raw upgrade request, because
// the access token rides in its query string. server.js boots the server on import,
// so this scans its source instead: every console.* / collabDebug call's arguments
// (string contents blanked, template ${…} expressions kept) must not reference the
// request URL, headers, query params or the credential.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const SERVER_JS = process.env.SERVER_JS_PATH || new URL("./server.js", import.meta.url);

// Identifiers that would put the token (or a container of it) into a log line.
const FORBIDDEN = [
  /\breq\.(url|headers|rawHeaders)\b/,
  /\bsearchParams\b/,
  /\bcredential\b/,
  /\btoken\b/,
  /(^|[^\w.$])url\b/, // the parsed `new URL(req.url)` object (not API_URL / x.url)
];

/**
 * Returns the argument code of every log call in `src`, with the contents of string
 * literals replaced by spaces (so message text can't trip the check) but template
 * ${…} expressions kept (so `${req.url}` still does).
 */
function logCallArgs(src) {
  const calls = [];
  const start = /\b(console\.(log|info|warn|error|debug)|collabDebug)\s*\(/g;
  let m;
  while ((m = start.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 1;
    let code = "";
    const stack = []; // open quote chars / "${" markers
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      const top = stack[stack.length - 1];
      if (top === "'" || top === '"' || top === "`") {
        if (c === "\\") { i++; code += "  "; continue; }
        if (c === top) { stack.pop(); code += c; continue; }
        if (top === "`" && c === "$" && src[i + 1] === "{") { stack.push("${"); code += "${"; i++; continue; }
        code += c === "\n" ? "\n" : " ";
        continue;
      }
      if (c === "'" || c === '"' || c === "`") { stack.push(c); code += c; continue; }
      if (top === "${" && c === "}") { stack.pop(); code += c; continue; }
      if (!stack.length && c === "(") depth++;
      if (!stack.length && c === ")") depth--;
      if (depth > 0) code += c;
    }
    const line = src.slice(0, m.index).split("\n").length;
    calls.push({ line, code });
  }
  return calls;
}

test("the scanner sees through template literals but not plain message text", () => {
  const [a, b] = logCallArgs('console.log(`url: ${req.url}`); console.log("token url credential");');
  assert.match(a.code, /req\.url/);
  assert.ok(FORBIDDEN.every((re) => !re.test(b.code)), b.code);
});

test("server.js never logs the request URL, headers, query params or credential", () => {
  const calls = logCallArgs(fs.readFileSync(SERVER_JS, "utf8"));
  assert.ok(calls.length > 20, `expected to find server.js log calls, found ${calls.length}`);
  const offenders = calls.filter(({ code }) => FORBIDDEN.some((re) => re.test(code)));
  assert.deepEqual(
    offenders.map(({ line, code }) => `server.js:${line}: ${code.replace(/\s+/g, " ").trim()}`),
    [],
    "log only docNameForLog / upgradeContextForLog from logsafe.js (#220)",
  );
});

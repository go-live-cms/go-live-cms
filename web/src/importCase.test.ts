// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// #258: an import whose case differs from the file name resolves on the
// case-insensitive Windows bind mount but breaks on Linux. vitest only loads the
// modules a test imports, so check every relative and aliased import here by
// matching each path segment against the real directory listing.
const root = fileURLToPath(new URL("..", import.meta.url))
const scanned = ["src", "gl-admin", "themes"]
const aliases: Record<string, string> = { "@/": "src/", "@gl-admin/": "gl-admin/", "@themes/": "themes/" }
const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".astro", "/index.ts", "/index.tsx", "/index.js"]
const importPattern = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full)
    return /\.(tsx?|jsx?|mjs|astro)$/.test(entry.name) ? [full] : []
  })

// "exact" when every segment matches the listing, "case" when only a
// case-insensitive match exists, null when nothing matches.
const lookup = (target: string): "exact" | "case" | null => {
  const segments = path.relative(root, target).split(path.sep)
  let dir = root
  let exact = true
  for (const segment of segments) {
    if (segment === "..") return existsSync(target) ? "exact" : null
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return null
    const names = readdirSync(dir)
    const match = names.includes(segment) ? segment : names.find((n) => n.toLowerCase() === segment.toLowerCase())
    if (!match) return null
    if (match !== segment) exact = false
    dir = path.join(dir, match)
  }
  return exact ? "exact" : "case"
}

describe("import paths", () => {
  // A synchronous walk of every web/ source file: a few seconds on a slow file
  // share or with the astro test project running alongside, past vitest's 5s default.
  it("match the case of the files they import", () => {
    const mismatches: string[] = []
    for (const file of scanned.flatMap((dir) => sourceFiles(path.join(root, dir)))) {
      for (const [, spec] of readFileSync(file, "utf8").matchAll(importPattern)) {
        const alias = Object.keys(aliases).find((prefix) => spec.startsWith(prefix))
        if (!spec.startsWith(".") && !alias) continue
        const base = alias
          ? path.join(root, aliases[alias], spec.slice(alias.length))
          : path.join(path.dirname(file), spec)
        const results = extensions.map((ext) => lookup(base.split("?")[0] + ext))
        if (!results.includes("exact") && results.includes("case")) {
          mismatches.push(`${path.relative(root, file)}: "${spec}"`)
        }
      }
    }
    expect(mismatches).toEqual([])
  }, 30_000)
})

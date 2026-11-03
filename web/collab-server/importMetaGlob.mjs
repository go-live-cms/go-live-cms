// esbuild plugin: Vite's eager `import.meta.glob("<relative pattern>", { eager: true })`
// for bundles esbuild builds (the collab server, build.mjs; the theme block manifest,
// scripts/theme-blocks-manifest.mjs), so code shared with the Vite-built admin and SSR
// server resolves the themes' blocks the same way, when the bundle is built (#376).
//
// Only what the code base uses: a string literal pattern relative to the importing file,
// `*` within a path segment (no `**`, no braces), `{ eager: true }`. The result is the
// same object Vite builds: each matching path, as written relative to the importer, to
// that module's namespace. Any other `import.meta.glob(` call fails the build rather than
// shipping a bundle without the modules it expects.
import { promises as fs } from "node:fs"
import path from "node:path"

const CALL = /import\.meta\.glob\s*(?:<[^()]*>)?\s*\(/g
const EAGER = /^import\.meta\.glob\s*(?:<[^()]*>)?\s*\(\s*(["'])([^"']+)\1\s*,\s*\{\s*eager\s*:\s*true\s*,?\s*\}\s*\)/

/** The paths matching `pattern` (relative, `*` per segment) from `dir`, as written, sorted. */
export async function expandGlob(dir, pattern) {
  if (!pattern.startsWith("./") && !pattern.startsWith("../")) throw new Error(`import.meta.glob: "${pattern}" must be relative`)
  if (pattern.includes("**") || /[{}[\]]/.test(pattern)) throw new Error(`import.meta.glob: "${pattern}" uses an unsupported glob`)
  const segments = pattern.split("/")
  let matches = [{ written: [], absolute: dir }]
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1
    const next = []
    for (const { written, absolute } of matches) {
      if (!segment.includes("*")) {
        next.push({ written: [...written, segment], absolute: path.join(absolute, segment) })
        continue
      }
      const regex = new RegExp(`^${segment.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`)
      const entries = await fs.readdir(absolute, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!regex.test(entry.name) || entry.name.startsWith(".")) continue
        if (last ? !entry.isFile() : !entry.isDirectory()) continue
        next.push({ written: [...written, entry.name], absolute: path.join(absolute, entry.name) })
      }
    }
    matches = next
  }
  const found = []
  for (const match of matches) {
    const stat = await fs.stat(match.absolute).catch(() => null)
    if (stat?.isFile()) found.push({ key: match.written.join("/"), file: match.absolute })
  }
  return found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** `source` with every eager glob call replaced by an object of imported namespaces. */
export async function transformGlobs(source, file) {
  const calls = [...source.matchAll(CALL)]
  if (calls.length === 0) return null
  const imports = []
  let output = ""
  let cursor = 0
  for (const [n, call] of calls.entries()) {
    const match = EAGER.exec(source.slice(call.index))
    if (!match) throw new Error(`${file}: only import.meta.glob("<relative pattern>", { eager: true }) is supported in esbuild bundles`)
    const entries = await expandGlob(path.dirname(file), match[2])
    const fields = entries.map(({ key, file: target }, m) => {
      const name = `__glob_${n}_${m}`
      imports.push(`import * as ${name} from ${JSON.stringify(target.replaceAll("\\", "/"))};`)
      return `${JSON.stringify(key)}: ${name}`
    })
    output += source.slice(cursor, call.index) + `{${fields.join(", ")}}`
    cursor = call.index + match[0].length
  }
  output += source.slice(cursor)
  return `${imports.join("\n")}\n${output}`
}

export const importMetaGlob = {
  name: "import-meta-glob",
  setup(build) {
    build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
      if (args.path.includes(`${path.sep}node_modules${path.sep}`) || args.path.includes("/node_modules/")) return undefined
      const source = await fs.readFile(args.path, "utf8")
      if (!source.includes("import.meta.glob")) return undefined
      const contents = await transformGlobs(source, args.path)
      if (contents === null) return undefined
      const ext = path.extname(args.path).slice(1)
      const loader = ext.startsWith("m") || ext.startsWith("c") ? ext.slice(1) : ext
      return { contents, loader, resolveDir: path.dirname(args.path) }
    })
  },
}

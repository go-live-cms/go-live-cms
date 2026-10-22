// Sets every @tiptap/* dependency and override in web/package.json to one exact
// version (#193). @tiptap/y-tiptap has its own release line and is left alone.
// Usage (from web/): node scripts/bump-tiptap.mjs 3.x.y
// Then regenerate the lockfile in the web container and follow the "Upgrading
// TipTap" checklist in web/CLAUDE.md.
import { readFileSync, writeFileSync } from "node:fs"

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("usage: node scripts/bump-tiptap.mjs <exact version, e.g. 3.4.2>")
  process.exit(1)
}

const path = new URL("../package.json", import.meta.url)
const pkg = JSON.parse(readFileSync(path, "utf8"))
const isPinned = (name) => name.startsWith("@tiptap/") && name !== "@tiptap/y-tiptap"

for (const name of Object.keys(pkg.dependencies)) {
  if (isPinned(name)) pkg.dependencies[name] = version
}
for (const name of Object.keys(pkg.overrides ?? {})) {
  // "$name" references follow the direct dependency, so only literals change.
  if (isPinned(name) && !pkg.overrides[name].startsWith("$")) pkg.overrides[name] = version
}

writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n")
console.log(`@tiptap/* set to ${version}; now run npm install in the web container`)

// The production web server's entry (web/Dockerfile, #378): every console line becomes
// one JSON record (server/logFormat.mjs) before the @astrojs/node standalone server
// loads, so Astro's own output (startup banner, uncaught page errors) is structured
// like the app's src/lib/log.ts lines. The middleware loads only on the first request,
// too late for the banner, hence a wrapper rather than code in the app.
import { format } from "node:util"
import { installConsoleJson } from "./logFormat.mjs"

installConsoleJson(process.stdout, process.stderr, format)

// What Node writes to stderr itself goes through the console too. Process warnings
// (deprecations, MaxListeners) replace Node's own printer. A crash (an uncaught
// exception, or an unhandled rejection, which Node turns into one) is logged as one
// record and still exits 1, as Node would.
process.removeAllListeners("warning")
process.on("warning", (warning) => console.warn(warning))
process.on("uncaughtException", (error) => {
  console.error("uncaught exception:", error)
  process.exit(1)
})

await import("../dist/server/entry.mjs")

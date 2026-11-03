// The production web server's entry (web/Dockerfile, #378): every console line becomes
// one JSON record (server/logFormat.mjs) before the @astrojs/node standalone server
// loads, so Astro's own output (startup banner, uncaught page errors) is structured
// like the app's src/lib/log.ts lines. The middleware loads only on the first request,
// too late for the banner, hence a wrapper rather than code in the app.
import { installConsoleJson } from "./logFormat.mjs"

installConsoleJson(process.stdout, process.stderr)
await import("../dist/server/entry.mjs")

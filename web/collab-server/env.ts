// Environment reading for main.ts. Secrets may come from a file instead (#158): when
// NAME_FILE is set, NAME is that file's trimmed contents. This is the compose secrets
// convention (compose.yaml mounts them at /run/secrets/<name>), the same as the API's
// <NAME>_FILE (util/config.go).
import { readFileSync } from "node:fs"
import { errorMessage } from "./logsafe"

export type Env = Record<string, string | undefined>

/** NAME, trimmed; "" when unset. */
export function readEnv(env: Env, name: string): string {
  return (env[name] ?? "").trim()
}

/**
 * NAME, or the trimmed contents of the file NAME_FILE names. Setting both is an
 * error, so it's never unclear which one is in use. Errors name the variables and
 * the path, never the contents.
 */
export function readSecretEnv(env: Env, name: string, readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): string {
  const value = readEnv(env, name)
  const file = readEnv(env, `${name}_FILE`)
  if (!file) return value
  if (value) throw new Error(`both ${name} and ${name}_FILE are set: use one`)
  try {
    return readFile(file).trim()
  } catch (error) {
    throw new Error(`${name}_FILE: could not read ${file}: ${errorMessage(error)}`)
  }
}

import type { Redirect, RedirectSource } from "@gl-admin/lib/api/redirects"
import { ApiError, errorMessage } from "@gl-admin/lib/api/errors"
import { plural } from "@gl-admin/utils/formatting"

// Settings › URLs & redirects (#331): the add form's checks (the API's rules, so most
// mistakes are caught before a request), the API's codes as messages, and how a row reads.
// Pure; tested in redirects.test.ts.

// The API refuses a from_path under these: they're the admin, the API and static files.
export const RESERVED_PREFIXES = ["/gl-admin", "/api", "/uploads", "/themes"]

export function isExternal(to: string): boolean {
  return /^https?:\/\//i.test(to.trim())
}

// The API drops a trailing slash from from_path ("/old/" and "/old" are one address).
export function normalizeFrom(from: string): string {
  const trimmed = from.trim()
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") || "/" : trimmed
}

export function normalizeTo(to: string): string {
  return to.trim()
}

export type RedirectErrors = { from?: string; to?: string }

function reservedPrefix(path: string): string | undefined {
  const lower = path.toLowerCase()
  return RESERVED_PREFIXES.find((p) => lower === p || lower.startsWith(`${p}/`))
}

export function validateFrom(raw: string): string | undefined {
  const from = normalizeFrom(raw)
  if (!from) return "Enter the old address, like /blog/old-post."
  if (/\s/.test(from)) return "An address can’t contain spaces."
  if (isExternal(from)) return "Enter a path on this site, like /blog/old-post, without the domain."
  if (!from.startsWith("/") || from.startsWith("//")) return "Start the old address with a single /, like /blog/old-post."
  if (/[?#]/.test(from)) return "Leave out the ? or # part: a redirect matches the path only."
  const reserved = reservedPrefix(from)
  if (reserved) return `Addresses under ${reserved} can’t be redirected.`
  return undefined
}

export function validateTo(raw: string): string | undefined {
  const to = normalizeTo(raw)
  if (!to) return "Enter the new address: a path like /blog/new-post, or a full https:// link."
  if (/\s/.test(to)) return "An address can’t contain spaces."
  if (isExternal(to)) {
    try {
      const url = new URL(to)
      if (!url.hostname) throw new Error("no host")
    } catch {
      return "That link isn’t complete. Check the address, like https://example.com/page."
    }
    return undefined
  }
  if (!to.startsWith("/") || to.startsWith("//")) return "Start with / for a page on this site, or https:// for another site."
  return undefined
}

// Both fields' problems, or {} when the redirect can be sent.
export function validateRedirect(from: string, to: string): RedirectErrors {
  const errors: RedirectErrors = {}
  const fromError = validateFrom(from)
  const toError = validateTo(to)
  if (fromError) errors.from = fromError
  if (toError) errors.to = toError
  if (!fromError && !toError && !isExternal(to) && normalizeFrom(to) === normalizeFrom(from)) {
    errors.to = "The new address is the same as the old one."
  }
  return errors
}

// The API's answer to POST /redirects, on the field it's about when there is one.
export function redirectErrorMessage(error: unknown, from: string): { field: keyof RedirectErrors | null; message: string } {
  if (error instanceof ApiError) {
    if (error.code === "redirect_exists") {
      return { field: "from", message: `${normalizeFrom(from)} already redirects somewhere. Delete that redirect first.` }
    }
    if (error.code === "redirect_loop") {
      return { field: "to", message: "That would send visitors in a loop: the new address leads back to the old one." }
    }
  }
  return { field: null, message: errorMessage(error) }
}

export function statusLabel(code: number): string {
  return code === 302 ? "Temporary" : "Permanent"
}

// Why GoLive added a redirect itself; null for one added by hand.
export function sourceDescription(source: RedirectSource | string): string | null {
  switch (source) {
    case "manual":
      return null
    case "post":
      return "Added automatically when a post’s address changed"
    case "term":
      return "Added automatically when a slug changed"
    case "merge":
      return "Added automatically when tags were merged"
    default:
      return "Added automatically"
  }
}

// "Ana Costa"; without a member, "Automatic" for one GoLive added, else "A former member".
export function creatorName(redirect: Pick<Redirect, "created_by" | "source">): string {
  const person = redirect.created_by
  const name = (person?.full_name || person?.username || "").trim()
  if (name) return name
  return redirect.source === "manual" ? "A former member" : "Automatic"
}

export function redirectCount(total: number): string {
  return plural(total, "redirect", "redirects")
}

// Adds the next page, skipping rows already shown (a redirect added here moves the
// offsets by one).
export function appendRedirects(shown: Redirect[], page: Redirect[]): Redirect[] {
  const ids = new Set(shown.map((r) => r.id))
  return [...shown, ...page.filter((r) => !ids.has(r.id))]
}

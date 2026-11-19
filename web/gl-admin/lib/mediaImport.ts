import type { Media } from "./api/types"

// "Add from URL" (#29; the canvas's "Media · Add from URL" board): the rules behind the
// dialog in the media library and the form in the media picker. The API
// (`POST /media/import`) downloads each link and stores it like an upload; the library
// never hotlinks. This module only reads the links out of the text box and words the
// results. What may be imported (types, size, addresses) is decided by the API alone.

/** The API's `mediaImportMaxURLs`: the most links one request may carry. */
export const MAX_IMPORT_LINKS = 10
/** The API's `mediaImportURLMax`. */
export const MAX_IMPORT_LINK_LENGTH = 2048

export interface ImportLinks {
  /** The links to send, in order, each once. */
  links: string[]
  /** What stops the request, worded for the field; empty when it may be sent. */
  problem: string | null
}

/**
 * Reads the text box: one link per line, blank lines ignored, repeats sent once. `links`
 * counts every good line (the button says "Add 2 files" even while line 3 is wrong);
 * `problem` names the first bad one.
 */
export function parseImportLinks(text: string): ImportLinks {
  const links: string[] = []
  let problem: string | null = null
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (!isHTTPLink(line)) {
      problem ??= `Line ${i + 1} isn't a link starting with http:// or https://.`
    } else if (line.length > MAX_IMPORT_LINK_LENGTH) {
      problem ??= `Line ${i + 1} is too long for a link.`
    } else if (!links.includes(line)) {
      links.push(line)
    }
  }
  if (problem === null && links.length > MAX_IMPORT_LINKS) {
    problem = `Add up to ${MAX_IMPORT_LINKS} links at a time (you have ${links.length}).`
  }
  return { links, problem }
}

function isHTTPLink(text: string): boolean {
  try {
    const url = new URL(text)
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== ""
  } catch {
    return false
  }
}

/** The primary button: "Add files", "Add 1 file", "Add 3 files". */
export function addButtonLabel(count: number): string {
  if (count === 0) return "Add files"
  return `Add ${count} file${count === 1 ? "" : "s"}`
}

/** A link as a row shows it: host and path, no scheme, query or fragment. */
export function shortLink(link: string): string {
  try {
    const url = new URL(link)
    const path = url.pathname === "/" ? "" : url.pathname
    return `${url.host}${path}`
  } catch {
    return link
  }
}

/** One link's outcome, as the API answers it. */
export type ImportResult =
  | { url: string; status: "added"; media: Media }
  | { url: string; status: "failed"; code: string; error: string }

export interface ImportResponse {
  results: ImportResult[]
  meta: { total: number; successful: number; failed: number }
}

/** "2 added, 1 failed", "3 added", "1 failed". */
export function importSummary(results: ImportResult[]): string {
  const added = results.filter((r) => r.status === "added").length
  const failed = results.length - added
  if (failed === 0) return `${added} added`
  if (added === 0) return `${failed} failed`
  return `${added} added, ${failed} failed`
}

/** The row's text: "Added as photo.jpg", or the API's reason. */
export function resultLine(result: ImportResult): string {
  if (result.status === "added") return `Added as ${result.media.original_filename || result.media.name}`
  return result.error || "The file couldn't be added"
}

/** The links that failed, for "Try failed again" (back in the text box). */
export function failedLinks(results: ImportResult[]): string[] {
  return results.filter((r) => r.status === "failed").map((r) => r.url)
}

/** What a whole request's failure says (the API's 429, or anything else). */
export function importRequestError(status: number | undefined, fallback: string): string {
  if (status === 429) return "Too many imports. Try again in a minute."
  return fallback
}

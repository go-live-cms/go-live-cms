// API errors as the admin shows them. The API answers errors with
// `{"error": "...", "code": "..."}` (code only on some); a 429 from the rate
// limiter (#190) also sends Retry-After. ApiError.message is always a sentence
// a user can read: never a raw status line or response body (an HTML error
// page from a proxy, say). Callers that need to tell cases apart use status
// and code, not the English text.

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null = null,
    // The API's machine-readable {"code": ...}, when present.
    readonly code: string | null = null,
    // The API's own {"error": ...} text, if the body had one.
    readonly serverMessage: string | null = null,
    // The API's {"request_id": ...} (or the X-Request-ID header): the error ID a user
    // can report, which matches the API's log line for the request.
    readonly requestId: string | null = null
  ) {
    super(message)
    this.name = "ApiError"
  }
}

function sentence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return trimmed
  const capitalized = trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`
}

type FriendlyOptions = {
  serverMessage?: string | null
  retryAfterSeconds?: number | null
  // Message for statuses with no specific wording and no server message.
  fallback?: string
  // On /auth/* endpoints a 401 means bad credentials, so the server's message
  // ("invalid credentials") is the right thing to show.
  authEndpoint?: boolean
}

export function friendlyApiMessage(status: number, options: FriendlyOptions = {}): string {
  const { serverMessage, retryAfterSeconds, fallback, authEndpoint } = options

  if (status === 401) {
    if (authEndpoint && serverMessage) return sentence(serverMessage)
    return "Your session has expired. Please sign in again."
  }
  if (status === 403) {
    // A bare "forbidden" comes from the role middleware; anything more specific
    // ("you can only delete your own media") is worth showing as is.
    if (serverMessage && serverMessage.toLowerCase() !== "forbidden") return sentence(serverMessage)
    return "You don't have permission to do that. Ask an administrator if you need access."
  }
  if (status === 404) {
    return serverMessage
      ? `${sentence(serverMessage)} It may have been deleted or moved.`
      : "We couldn't find what you were looking for. It may have been deleted or moved."
  }
  if (status === 429) {
    const wait =
      retryAfterSeconds && retryAfterSeconds > 0
        ? `Please wait ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"} and try again.`
        : "Please wait a moment and try again."
    return `You're doing that too often. ${wait}`
  }
  if (status >= 500) {
    return "Something went wrong on the server. Please try again in a moment."
  }
  if (serverMessage) return sentence(serverMessage)
  return fallback || `The request failed (HTTP ${status}).`
}

// Builds an ApiError from a non-OK response. Reads the body, so the response
// must not have been consumed yet.
export async function apiErrorFromResponse(
  response: Response,
  options: Pick<FriendlyOptions, "fallback" | "authEndpoint"> = {}
): Promise<ApiError> {
  let serverMessage: string | null = null
  let code: string | null = null
  let requestId: string | null = null
  try {
    const text = await response.text()
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed.error === "string") serverMessage = parsed.error
    if (parsed && typeof parsed.code === "string") code = parsed.code
    if (parsed && typeof parsed.request_id === "string" && parsed.request_id) requestId = parsed.request_id
  } catch {
    // Not JSON (or no body): never show the raw text.
  }
  // A non-JSON error (a proxy's HTML page) has no body field; the API sets the header
  // on every response it answers.
  requestId ??= response.headers.get("X-Request-ID") || null
  const retryAfter = Number.parseInt(response.headers.get("Retry-After") ?? "", 10)
  const retryAfterSeconds = Number.isFinite(retryAfter) ? retryAfter : null
  const message = friendlyApiMessage(response.status, { ...options, serverMessage, retryAfterSeconds })
  return new ApiError(message, response.status, retryAfterSeconds, code, serverMessage, requestId)
}

// fetch() rejects with a TypeError when the server can't be reached at all;
// the wording differs per browser.
function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError && /fetch|network|load failed/i.test(error.message)
}

// Built-in JS errors are bugs, not something to show a user.
const BUILTIN_ERRORS = [TypeError, ReferenceError, SyntaxError, RangeError, EvalError, URIError]

// The message to show for anything a request (or a page) threw. Our own Error
// subclasses (RefreshError, UnauthorizedError, ...) carry readable messages.
export function errorMessage(error: unknown, fallback = "Something went wrong. Please try again."): string {
  if (error instanceof ApiError) return error.message
  if (isNetworkError(error)) return "Couldn't reach the server. Check your connection and try again."
  if (error instanceof Error && error.message && !BUILTIN_ERRORS.some((E) => error instanceof E)) {
    return error.message
  }
  return fallback
}

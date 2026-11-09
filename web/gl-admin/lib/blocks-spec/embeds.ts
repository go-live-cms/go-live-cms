/**
 * The embed block (#425, design `docs/design/block-library.md` section 5): YouTube, Vimeo, X
 * and "Embed a link" for the other allowed providers.
 *
 * A block stores `provider`, `ref` (that provider's id, by its pattern below) and a
 * plain-text `title`. Never HTML from a provider, and never a pasted URL: `POST
 * /embeds/resolve` turns a link into a provider and ref, and every address the page later
 * uses is built here from a fixed template.
 *
 * **Nothing loads until someone clicks**, in the editor and on the site. The public page
 * shows a placeholder and `web/public/gl-embeds.js` builds the player on click; that script
 * holds its own copy of the templates (it isn't bundled), which `embedLoader.test.ts` checks
 * against this table. The API holds the URL patterns and oEmbed endpoints
 * (`api/embeds.go`); `embedVectors.json` is shared with it.
 *
 * Pure data and functions (no React, ProseMirror or Zod), shared by the editor, the collab
 * server, the public renderer and the tests.
 */

export const EMBED_BLOCK_VERSION = 1

/** The providers, in the order the settings and messages list them. The API's `embedProviders`. */
export const EMBED_PROVIDERS = ["youtube", "vimeo", "x", "codepen", "soundcloud", "spotify"] as const
export type EmbedProvider = (typeof EMBED_PROVIDERS)[number]

/** Longest title, in code points (runes in the API's sanitizer, `embedTitleMaxRunes`). */
export const EMBED_TITLE_MAX_LENGTH = 200

export interface EmbedFrame {
  src: string
  /** Only what the provider's player needs; every other sandbox restriction stays on. */
  sandbox: string
  referrerPolicy: "no-referrer" | "strict-origin-when-cross-origin"
  allow: string
}

export interface EmbedProviderSpec {
  /** "YouTube": the setting's label and the name in messages. */
  name: string
  /** "YouTube video": the placeholder's eyebrow. */
  kind: string
  /** "youtube.com": "Loading it connects to youtube.com". */
  host: string
  /** The button: "Load video". */
  load: string
  /** A card (no fixed proportions) instead of a 16:9 frame. */
  card: boolean
  /** A short player (a fixed height, not 16:9), for audio. */
  compact: boolean
  ref: RegExp
  /** The item's page, built from a valid ref: what the Link field shows. */
  canonical: (ref: string) => string
  /** The player's address and iframe attributes; null when the provider isn't an iframe (X). */
  frame: ((ref: string) => EmbedFrame) | null
  /** The hosts its iframes come from: the public CSP's `frame-src`, and the admin's. */
  frameHosts: readonly string[]
}

// Each player's sandbox is the least it runs with: its scripts and its own origin (for its
// storage), and popups so "Watch on …" opens. Sandbox flags only ever take rights away from
// a cross-origin frame.
const PLAYER_SANDBOX = "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"

export const EMBED_PROVIDER_SPECS: Readonly<Record<EmbedProvider, EmbedProviderSpec>> = {
  youtube: {
    name: "YouTube",
    kind: "YouTube video",
    host: "youtube.com",
    load: "Load video",
    card: false,
    compact: false,
    ref: /^[A-Za-z0-9_-]{11}$/,
    canonical: (ref) => `https://www.youtube.com/watch?v=${ref}`,
    frame: (ref) => ({
      src: `https://www.youtube-nocookie.com/embed/${ref}`,
      sandbox: PLAYER_SANDBOX,
      // YouTube refuses to play ("Error 153") with no referrer at all; this sends only the
      // site's origin, never the page's path.
      referrerPolicy: "strict-origin-when-cross-origin",
      allow: "accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen",
    }),
    frameHosts: ["https://www.youtube-nocookie.com"],
  },
  vimeo: {
    name: "Vimeo",
    kind: "Vimeo video",
    host: "vimeo.com",
    load: "Load video",
    card: false,
    compact: false,
    ref: /^[0-9]{1,12}(?:\/[0-9a-f]{6,32})?$/,
    canonical: (ref) => `https://vimeo.com/${ref}`,
    frame: (ref) => {
      const [id, hash] = ref.split("/")
      return {
        src: `https://player.vimeo.com/video/${id}?dnt=1${hash ? `&h=${hash}` : ""}`,
        sandbox: PLAYER_SANDBOX,
        // A video limited to some domains is checked against the origin.
        referrerPolicy: "strict-origin-when-cross-origin",
        allow: "encrypted-media; picture-in-picture; fullscreen",
      }
    },
    frameHosts: ["https://player.vimeo.com"],
  },
  x: {
    name: "X",
    kind: "Post on X",
    host: "x.com",
    load: "Load post",
    card: true,
    compact: false,
    ref: /^[0-9]{1,25}$/,
    canonical: (ref) => `https://x.com/i/status/${ref}`,
    // The site loads X's widget on click; the widget makes the iframe, on this host.
    frame: null,
    frameHosts: ["https://platform.twitter.com"],
  },
  codepen: {
    name: "CodePen",
    kind: "CodePen",
    host: "codepen.io",
    load: "Load embed",
    card: false,
    compact: false,
    ref: /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9]{1,16}$/,
    canonical: (ref) => {
      const [user, pen] = ref.split("/")
      return `https://codepen.io/${user}/pen/${pen}`
    },
    frame: (ref) => {
      const [user, pen] = ref.split("/")
      return {
        src: `https://codepen.io/${user}/embed/${pen}?default-tab=result`,
        // A pen's forms and modals run inside the player.
        sandbox: `${PLAYER_SANDBOX} allow-forms allow-modals`,
        referrerPolicy: "no-referrer",
        allow: "fullscreen",
      }
    },
    frameHosts: ["https://codepen.io"],
  },
  soundcloud: {
    name: "SoundCloud",
    kind: "SoundCloud",
    host: "soundcloud.com",
    load: "Load embed",
    card: false,
    compact: true,
    ref: /^[a-z0-9_-]{1,100}(?:\/sets)?\/[a-z0-9_-]{1,200}$/,
    canonical: (ref) => `https://soundcloud.com/${ref}`,
    frame: (ref) => ({
      src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(`https://soundcloud.com/${ref}`)}`,
      sandbox: PLAYER_SANDBOX,
      referrerPolicy: "no-referrer",
      allow: "encrypted-media",
    }),
    frameHosts: ["https://w.soundcloud.com"],
  },
  spotify: {
    name: "Spotify",
    kind: "Spotify",
    host: "spotify.com",
    load: "Load embed",
    card: false,
    compact: true,
    ref: /^(?:track|album|playlist|episode|show)\/[A-Za-z0-9]{22}$/,
    canonical: (ref) => `https://open.spotify.com/${ref}`,
    frame: (ref) => ({
      src: `https://open.spotify.com/embed/${ref}`,
      sandbox: PLAYER_SANDBOX,
      referrerPolicy: "no-referrer",
      allow: "encrypted-media; fullscreen; picture-in-picture",
    }),
    frameHosts: ["https://open.spotify.com"],
  },
}

export function isEmbedProvider(value: unknown): value is EmbedProvider {
  return typeof value === "string" && (EMBED_PROVIDERS as readonly string[]).includes(value)
}

/** Whether `ref` is an item of `provider`, by that provider's pattern (the API's `validEmbedRef`). */
export function isValidEmbedRef(provider: unknown, ref: unknown): boolean {
  return isEmbedProvider(provider) && typeof ref === "string" && EMBED_PROVIDER_SPECS[provider].ref.test(ref)
}

/** At most EMBED_TITLE_MAX_LENGTH code points (an input's maxLength counts UTF-16 units). */
export function capEmbedTitle(value: string): string {
  const points = [...value]
  return points.length > EMBED_TITLE_MAX_LENGTH ? points.slice(0, EMBED_TITLE_MAX_LENGTH).join("") : value
}

/**
 * A title as stored, exactly as the API sanitizer makes it (a file label's rules, and never
 * HTML): control characters as spaces, trimmed, capped, null when empty or when it holds a
 * tag ("<" before a letter, "/", "!" or "?"; "a < b" and "I <3 this" are text). A block with
 * no title shows its provider's name.
 */
export function normalizeEmbedTitle(value: unknown): string | null {
  if (typeof value !== "string") return null
  const title = capEmbedTitle(value.replace(/\p{Cc}/gu, " ").trim()).trim()
  return title === "" || /<[a-zA-Z/!?]/.test(title) ? null : title
}

/** The provider of a stored block, or null. */
export function embedProviderOf(attrs: unknown): EmbedProvider | null {
  const provider = (attrs as { provider?: unknown } | null)?.provider
  return isEmbedProvider(provider) ? provider : null
}

/**
 * The attrs a block stores (and a node is rebuilt from): a known provider, a ref valid for
 * it, a normalized title, nothing that fails those rules.
 */
export function embedStoredAttrs(attrs: unknown): { provider?: EmbedProvider; ref?: string; title?: string } {
  const provider = embedProviderOf(attrs)
  const ref = (attrs as { ref?: unknown } | null)?.ref
  const title = normalizeEmbedTitle((attrs as { title?: unknown } | null)?.title)
  return {
    ...(provider ? { provider } : {}),
    ...(provider && isValidEmbedRef(provider, ref) ? { ref: ref as string } : {}),
    ...(title ? { title } : {}),
  }
}

/** A block's provider and ref when it can be shown; null for an empty or invalid one. */
export function embedTargetOf(attrs: unknown): { provider: EmbedProvider; ref: string } | null {
  const provider = embedProviderOf(attrs)
  const ref = (attrs as { ref?: unknown } | null)?.ref
  return provider && typeof ref === "string" && isValidEmbedRef(provider, ref) ? { provider, ref } : null
}

/**
 * The player the **editor** frames on Load, for every provider. X is a plain iframe of its
 * post page here: the admin's CSP has no room for X's widget script, and adding it would
 * weaken the one rule that keeps an XSS in the admin contained.
 */
export function embedPreviewFrame(provider: EmbedProvider, ref: string): EmbedFrame {
  const frame = EMBED_PROVIDER_SPECS[provider].frame
  if (frame) return frame(ref)
  return {
    src: `https://platform.twitter.com/embed/Tweet.html?id=${ref}&dnt=true`,
    sandbox: PLAYER_SANDBOX,
    referrerPolicy: "no-referrer",
    allow: "",
  }
}

/** The iframe's accessible name: "YouTube player: Two editors, one draft". */
export function embedFrameLabel(provider: EmbedProvider, title: string | null): string {
  const name = EMBED_PROVIDER_SPECS[provider].name
  return `${name} ${EMBED_PROVIDER_SPECS[provider].card ? "post" : "player"}${title ? `: ${title}` : ""}`
}

/** The ids of `allowed` this build knows, in `EMBED_PROVIDERS`' order. */
export function knownEmbedProviders(allowed: unknown): EmbedProvider[] {
  const list = Array.isArray(allowed) ? allowed : []
  return EMBED_PROVIDERS.filter((provider) => list.includes(provider))
}

/** Every host the given providers' players may be framed from: `frame-src`'s source list. */
export function embedFrameHosts(allowed: readonly EmbedProvider[]): string[] {
  return [...new Set(allowed.flatMap((provider) => EMBED_PROVIDER_SPECS[provider].frameHosts))]
}

/** "YouTube, Vimeo or X": the allowed sites in a sentence. */
export function embedProviderList(providers: readonly EmbedProvider[], conjunction = "or"): string {
  const names = providers.map((provider) => EMBED_PROVIDER_SPECS[provider].name)
  if (names.length < 2) return names.join("")
  return `${names.slice(0, -1).join(", ")} ${conjunction} ${names[names.length - 1]}`
}

/** The icons (the canvas's 24×24 strokes), by provider. */
const PLAY_ICON = "M3 6h18v12H3zM10 9l5 3-5 3z"
const POST_ICON = "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
export const EMBED_LINK_ICON = "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"

export const EMBED_ICONS = { youtube: PLAY_ICON, vimeo: PLAY_ICON, x: POST_ICON, link: EMBED_LINK_ICON } as const

/** A provider's icon: the three with blocks of their own, the link for the others. */
export function embedIconOf(provider: EmbedProvider | null): string {
  return provider === "youtube" || provider === "vimeo" || provider === "x" ? EMBED_ICONS[provider] : EMBED_LINK_ICON
}

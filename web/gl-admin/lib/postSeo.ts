// The post editor's SEO tab (#357): its fallbacks, character guides, canonical URL
// check and what it saves. Pure (tested in postSeo.test.ts); the tab is
// components/editor/ui/PostSeoPanel.tsx.
//
// Fallbacks match the public site (src/lib/seo.ts, which renders them): the SEO
// title falls back to the post title, the meta description to the excerpt, then the
// first paragraph (cut at a word before 160 characters), the social image to the
// featured image, then none. The guides (60 and 160) are soft: they never block typing.

import { metaDescription, SEO_DESCRIPTION_GUIDE, SEO_TITLE_GUIDE } from "@/lib/seo"
import type { Post, PostSEOSettings } from "@gl-admin/lib/api/types"

export { SEO_DESCRIPTION_GUIDE, SEO_TITLE_GUIDE }
// The excerpt's guide (it is optional, up to 500).
export const EXCERPT_GUIDE = 160

export const EMPTY_SEO: PostSEOSettings = {
  seo_title: "",
  seo_description: "",
  social_image_id: null,
  noindex: false,
  canonical_url: "",
}

export function seoFromPost(post: Pick<Post, "seo"> | null | undefined): PostSEOSettings {
  return { ...EMPTY_SEO, ...(post?.seo ?? {}) }
}

// Characters as the API counts them: code points (an emoji is one).
export const charCount = (s: string) => [...s].length

export interface SoftCount {
  count: number
  guide: number
  over: boolean
  // What the counter's aria-live region says.
  spoken: string
}

export function softCount(value: string, guide: number): SoftCount {
  const count = charCount(value)
  const over = count > guide
  return {
    count,
    guide,
    over,
    spoken: over ? `${count} of ${guide} characters. Search results may cut it off.` : `${count} of ${guide} characters`,
  }
}

// cutAtWord shortens text for a preview the way search results do: at a word, with
// an ellipsis.
export function cutAtWord(text: string, max: number): string {
  return metaDescription(text, max)
}

// The first paragraph of the editor's HTML (its onChange), as plain text: what the
// description falls back to when there's no excerpt.
export function firstParagraphFromHtml(html: string | null | undefined): string {
  const paragraphs = (html || "").match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || []
  for (const p of paragraphs) {
    const text = metaDescription(p, Number.MAX_SAFE_INTEGER)
    if (text) return text
  }
  return ""
}

export interface SeoFallbacks {
  title: string
  titleHint: string
  description: string
  descriptionPlaceholder: string
  descriptionHint: string
}

// The values the previews show and the hints under the fields.
export function seoFallbacks(input: {
  seo: PostSEOSettings
  postTitle: string
  excerpt: string
  firstParagraph: string
}): SeoFallbacks {
  const { seo, postTitle, excerpt, firstParagraph } = input
  const ownTitle = seo.seo_title.trim()
  const ownDescription = seo.seo_description.trim()
  const fallbackDescription = excerpt.trim() ? metaDescription(excerpt) : metaDescription(firstParagraph)
  const titleOver = charCount(ownTitle || postTitle) > SEO_TITLE_GUIDE
  const descriptionOver = charCount(ownDescription) > SEO_DESCRIPTION_GUIDE
  return {
    title: ownTitle || postTitle.trim(),
    titleHint: ownTitle
      ? titleOver
        ? "Search engines usually cut titles after about 60 characters."
        : "Shown in search results and browser tabs."
      : "Uses the post title",
    description: ownDescription || fallbackDescription,
    descriptionPlaceholder: excerpt.trim() || firstParagraph,
    descriptionHint: ownDescription
      ? descriptionOver
        ? "Search engines usually cut descriptions after about 160 characters."
        : "Shown under the title in search results."
      : excerpt.trim()
        ? "Uses the excerpt"
        : firstParagraph
          ? "Uses the first paragraph"
          : "Add an excerpt or a first paragraph, or write one here.",
  }
}

// The API's canonical URL rule (api/posts_seo.go validCanonicalURL): empty, or an
// absolute http(s) URL with a host, no spaces and no user:password part. null when
// it's fine, else the message shown under the field.
export function canonicalUrlError(value: string): string | null {
  const raw = value.trim()
  if (!raw) return null
  const message = `“${raw}” isn’t a complete URL. Start it with https:// and remove any spaces.`
  if (/\s|\\/.test(raw)) return message
  try {
    const url = new URL(raw)
    if (url.protocol !== "http:" && url.protocol !== "https:") return message
    if (!url.hostname || url.username || url.password) return message
    // new URL("https:example.com") is valid too; the API wants the "//".
    if (!/^https?:\/\//i.test(raw)) return message
  } catch {
    return message
  }
  return null
}

// The body of PUT /posts/:id/seo: every field, trimmed (it replaces them all).
export function seoPayload(seo: PostSEOSettings): PostSEOSettings {
  return {
    seo_title: seo.seo_title.replace(/\s*\n\s*/g, " ").trim(),
    seo_description: seo.seo_description.trim(),
    social_image_id: seo.social_image_id ?? null,
    noindex: !!seo.noindex,
    canonical_url: seo.canonical_url.trim(),
  }
}

export function sameSeo(a: PostSEOSettings, b: PostSEOSettings): boolean {
  const x = seoPayload(a)
  const y = seoPayload(b)
  return (
    x.seo_title === y.seo_title &&
    x.seo_description === y.seo_description &&
    x.social_image_id === y.social_image_id &&
    x.noindex === y.noindex &&
    x.canonical_url === y.canonical_url
  )
}

// Whether the form may be saved as it is: a canonical URL the API would refuse waits
// (the field shows why) instead of failing the save.
export function seoSaveable(seo: PostSEOSettings): boolean {
  return canonicalUrlError(seo.canonical_url) === null
}

// The address the search preview shows: "example.com › post › my-post".
export function previewAddress(siteAddress: string, path: string): string {
  let host = siteAddress
  try {
    host = new URL(siteAddress).host
  } catch {
    // Not a URL: as it is.
  }
  const segments = path.split("/").filter(Boolean)
  return [host, ...segments].filter(Boolean).join(" › ")
}

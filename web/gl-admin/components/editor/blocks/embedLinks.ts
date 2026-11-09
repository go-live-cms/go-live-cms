import type { Editor } from "@tiptap/core"
import { NodeSelection } from "@tiptap/pm/state"
import { isEmbedNotAllowed, resolveEmbed } from "@gl-admin/lib/api/embeds"
import { ApiError, errorMessage } from "@gl-admin/lib/api/errors"
import { currentAllowedEmbeds } from "@gl-admin/lib/editorSettings"
import { EMBED_PROVIDER_SPECS, EMBED_PROVIDERS, embedProviderList, type EmbedProvider } from "@gl-admin/lib/blocks-spec"
import { resolveEditorBlock, type BlockRef } from "../utils/blockTree"

// Turning a pasted link into an embed (#425): the block's field and the settings panel's
// Link field both come here. The API says which provider a link belongs to; what the editor
// does with the answer, and the words for each way it can fail ("Errors & empty states", "An
// embed link that isn't allowed"), are here.

/** The canvas's name for the error, and the API's. */
export const EMBED_NOT_ALLOWED_TITLE = "An embed link that isn't allowed"

export interface EmbedLinkError {
  /** Bold, above the message: only for a link that isn't allowed. */
  title?: string
  message: string
}

/** The address as the API needs it: a bare "youtu.be/abc" gets https://. Null if it can't be one. */
export function pastedEmbedUrl(raw: string): URL | null {
  const text = raw.trim()
  if (!text) return null
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`)
    return url.protocol === "https:" || url.protocol === "http:" ? url : null
  } catch {
    return null
  }
}

// Other hostnames that belong to a provider.
const HOST_ALIASES: Record<string, EmbedProvider> = { "youtu.be": "youtube", "youtube-nocookie.com": "youtube", "twitter.com": "x" }

/** The provider whose site `hostname` is, whether or not the link is one it can embed. */
export function embedProviderOfHost(hostname: string): EmbedProvider | null {
  const host = hostname.toLowerCase()
  const isOn = (site: string) => host === site || host.endsWith(`.${site}`)
  for (const provider of EMBED_PROVIDERS) {
    if (isOn(EMBED_PROVIDER_SPECS[provider].host)) return provider
  }
  for (const [site, provider] of Object.entries(HOST_ALIASES)) {
    if (isOn(site)) return provider
  }
  return null
}

/** "Paste a link from YouTube, Vimeo or X." with the sites the site allows now. */
function allowedSentence(): string {
  const allowed = currentAllowedEmbeds() ?? []
  return allowed.length > 0 ? `Paste a link from ${embedProviderList(allowed)}.` : "An admin can choose the sites in Settings › Editor."
}

export function notAllowedError(url: URL): EmbedLinkError {
  const host = url.hostname.replace(/^www\./, "")
  const provider = embedProviderOfHost(url.hostname)
  const allowed = currentAllowedEmbeds()
  // The right site, a link it can't embed (a channel, a search): that's not about the list.
  if (provider && (!allowed || allowed.includes(provider))) {
    return { title: EMBED_NOT_ALLOWED_TITLE, message: `That link doesn't point to something ${EMBED_PROVIDER_SPECS[provider].name} can embed. Paste the link to the item itself.` }
  }
  return { title: EMBED_NOT_ALLOWED_TITLE, message: `Embeds from ${host} aren't allowed on this site. ${allowedSentence()}` }
}

/** "That's a Vimeo link. Paste a YouTube link here, or use the Vimeo block." */
export function wrongProviderError(found: EmbedProvider, expected: EmbedProvider): EmbedLinkError {
  const foundName = EMBED_PROVIDER_SPECS[found].name
  const elsewhere = found === "youtube" || found === "vimeo" || found === "x" ? `the ${foundName} block` : "Embed a link"
  return { message: `That's a ${foundName} link. Paste a ${EMBED_PROVIDER_SPECS[expected].name} link here, or use ${elsewhere}.` }
}

/**
 * Resolves `raw` and points the block at it, in one transaction, found again by id when the
 * answer arrives. `expected`: a block made for one provider, which refuses another's link
 * until it has a link of its own. Null on success, else what to show.
 */
export async function applyEmbedLink(editor: Editor, block: BlockRef, raw: string, expected: EmbedProvider | null): Promise<EmbedLinkError | null> {
  const url = pastedEmbedUrl(raw)
  if (!url) return { message: "That doesn't look like a link. Paste the full address." }

  let resolved
  try {
    resolved = await resolveEmbed(url.href)
  } catch (error) {
    if (isEmbedNotAllowed(error)) return notAllowedError(url)
    if (error instanceof ApiError && error.status === 403) return { message: "Only editors and admins can add an embed link." }
    return { message: errorMessage(error, "The link couldn't be checked. Try again.") }
  }
  if (expected && resolved.provider !== expected) return wrongProviderError(resolved.provider, expected)

  if (!editor.isEditable || editor.isDestroyed) return null
  const target = resolveEditorBlock(editor.state.doc, block)
  if (!target || target.node.type.name !== "embed") return null
  const tr = editor.state.tr.setNodeMarkup(target.pos, undefined, {
    ...target.node.attrs,
    provider: resolved.provider,
    ref: resolved.ref,
    title: resolved.title || null,
  })
  if (editor.state.selection instanceof NodeSelection && editor.state.selection.from === target.pos) {
    tr.setSelection(NodeSelection.create(tr.doc, target.pos))
  }
  editor.view.dispatch(tr)
  return null
}

// The next empty embed this client makes takes the focus: the menus insert it, and the
// author pastes straight away. A collaborator's blocks never do.
let focusNextEmbed = false

export function requestEmbedFieldFocus() {
  focusNextEmbed = true
}

export function takeEmbedFieldFocus(): boolean {
  const wanted = focusNextEmbed
  focusNextEmbed = false
  return wanted
}

/** Tells the embed at `pos` to show its link field (the toolbar's Edit link). */
export const EMBED_EDIT_EVENT = "gl-embed-edit-link"

export function openEmbedLinkField(editor: Editor, pos: number) {
  editor.view.nodeDOM(pos)?.dispatchEvent(new CustomEvent(EMBED_EDIT_EVENT))
}

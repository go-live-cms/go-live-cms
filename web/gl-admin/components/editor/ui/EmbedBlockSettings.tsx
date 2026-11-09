import { useEffect, useId, useState } from "react"
import type { Editor as TiptapEditor } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { capEmbedTitle, EMBED_PROVIDER_SPECS, EMBED_TITLE_MAX_LENGTH, embedProviderList, embedProviderOf, embedTargetOf } from "@gl-admin/lib/blocks-spec"
import { currentAllowedEmbeds } from "@gl-admin/lib/editorSettings"
import { applyEmbedLink, type EmbedLinkError } from "../blocks/embedLinks"
import { resolveEditorBlock, type BlockRef } from "../utils/blockTree"

// The settings panel's Block tab for an embed (#425, "Editor · embeds"): its link, its title
// (filled in from the link, read by screen readers, the author's to change), the sites this
// site allows, and what loading it does.

const TITLE_HELP = "Shown on the placeholder and read by screen readers. Filled in from the link; you can change it."

export default function EmbedBlockSettings({ editor, node, blockRef }: { editor: TiptapEditor; node: PMNode; blockRef: BlockRef }) {
  const target = embedTargetOf(node.attrs)
  const canonical = target ? EMBED_PROVIDER_SPECS[target.provider].canonical(target.ref) : ""
  const provider = target?.provider ?? embedProviderOf(node.attrs)
  const spec = provider ? EMBED_PROVIDER_SPECS[provider] : null
  const allowed = currentAllowedEmbeds()
  const ids = useId()

  const [link, setLink] = useState(canonical)
  const [error, setError] = useState<EmbedLinkError | null>(null)
  const [busy, setBusy] = useState(false)

  // Someone else's change, or this block's own Edit link.
  useEffect(() => {
    setLink(canonical)
    setError(null)
  }, [canonical])

  const applyLink = async () => {
    if (busy || !editor.isEditable || link.trim() === canonical) return
    setBusy(true)
    setError(await applyEmbedLink(editor, blockRef, link, target ? null : provider))
    setBusy(false)
  }

  const setTitle = (value: string) => {
    if (!editor.isEditable) return
    const block = resolveEditorBlock(editor.state.doc, blockRef)
    if (!block) return
    const title = capEmbedTitle(value) || null
    if (title === (block.node.attrs.title ?? null)) return
    editor.view.dispatch(editor.state.tr.setNodeMarkup(block.pos, undefined, { ...block.node.attrs, title }))
  }

  return (
    <div className="block-settings__media">
      <div className="post-settings__field">
        <label className="post-settings__label" htmlFor={`${ids}-link`}>
          Link
        </label>
        <input
          id={`${ids}-link`}
          type="url"
          value={link}
          disabled={!editor.isEditable || busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${ids}-link-error` : undefined}
          onChange={(event) => setLink(event.currentTarget.value)}
          onBlur={() => void applyLink()}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            event.preventDefault()
            void applyLink()
          }}
        />
        {error && (
          <small id={`${ids}-link-error`} className="post-settings__field-error" role="alert">
            {error.title && <strong>{error.title} </strong>}
            {error.message}
          </small>
        )}
      </div>
      {target && (
        <div className="post-settings__field">
          <label className="post-settings__label" htmlFor={`${ids}-title`}>
            Title
          </label>
          <input
            id={`${ids}-title`}
            type="text"
            maxLength={EMBED_TITLE_MAX_LENGTH * 2}
            value={typeof node.attrs.title === "string" ? node.attrs.title : ""}
            placeholder={EMBED_PROVIDER_SPECS[target.provider].kind}
            disabled={!editor.isEditable}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
          <small className="post-settings__hint">{TITLE_HELP}</small>
        </div>
      )}
      {allowed && allowed.length > 0 && (
        <div className="post-settings__field">
          <span className="post-settings__label">Sites this site allows</span>
          <small className="post-settings__hint">{embedProviderList(allowed, "and")}</small>
        </div>
      )}
      {spec && (
        <p className="post-settings__hint">
          Loads only after a reader clicks {spec.load}. Until then the page sends nothing to {spec.host}.
        </p>
      )}
    </div>
  )
}

import { Fragment, useEffect, useState } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import { formatKeys, isShortcutReferenceKey, onShortcutReferenceOpen, shortcutSections } from "../utils/shortcuts"
import "@gl-admin/assets/styles/components/editor/shortcut-reference.scss"

// The editor's keyboard shortcut reference (#477): "?" anywhere on the editor page outside
// a field or the text, or the block menu's Keyboard shortcuts. The keys come from
// utils/shortcuts.ts, the same strings the keymaps bind. Mounted by the editor's top bar.

// Another dialog holds focus: "?" there is that dialog's (or nothing).
const modalOpen = () => document.querySelector('[aria-modal="true"]') !== null

export function ShortcutKeys({ keys }: { keys: readonly string[] }) {
  return (
    <span className="editor-shortcuts__keys">
      {keys.map((k, i) => (
        <Fragment key={k}>
          {i > 0 && (
            <span className="editor-shortcuts__or" aria-hidden="true">
              /
            </span>
          )}
          <kbd className="editor-shortcuts__key" aria-hidden="true">
            {formatKeys(k)}
          </kbd>
          <span className="editor-shortcuts__sr">{`${i > 0 ? " or " : ""}${formatKeys(k, undefined, true)}`}</span>
        </Fragment>
      ))}
    </span>
  )
}

export function ShortcutReferenceDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Keyboard shortcuts" size="medium">
      <div className="editor-shortcuts">
        {shortcutSections().map((section) => (
          <section key={section.title} className="editor-shortcuts__section" aria-labelledby={`editor-shortcuts-${section.title}`}>
            <h3 id={`editor-shortcuts-${section.title}`} className="editor-shortcuts__title">
              {section.title}
            </h3>
            <dl className="editor-shortcuts__list">
              {section.rows.map((row) => (
                <div key={row.label} className="editor-shortcuts__row">
                  <dt className="editor-shortcuts__label">{row.label}</dt>
                  <dd className="editor-shortcuts__value">
                    <ShortcutKeys keys={row.keys} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  )
}

export default function ShortcutReference() {
  const [open, setOpen] = useState(false)

  useEffect(() => onShortcutReferenceOpen(() => setOpen(true)), [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isShortcutReferenceKey(event) || modalOpen()) return
      event.preventDefault()
      setOpen(true)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  return <ShortcutReferenceDialog isOpen={open} onClose={() => setOpen(false)} />
}

import type { ReactNode } from "react"
import Button from "@gl-admin/components/ui/Button"
import "@gl-admin/assets/styles/components/ui/unsaved-changes-bar.scss"

type UnsavedChangesBarProps = {
  // Rendered only while there are changes to save.
  visible: boolean
  // Says what changed ("You changed the tagline"); defaults to "Unsaved changes".
  message?: ReactNode
  onSave: () => void
  onDiscard: () => void
  saving?: boolean
  saveLabel?: string
  // An error from the last save, shown in place of the message.
  error?: ReactNode
}

// The sticky bar at the bottom of a settings form (#338, the Settings board). Put it
// last inside the scrolling page; it sticks to the bottom of the viewport while the
// form is in view. A labelled region, so screen reader users can jump to it.
export default function UnsavedChangesBar({
  visible,
  message = "Unsaved changes",
  onSave,
  onDiscard,
  saving = false,
  saveLabel = "Save changes",
  error,
}: UnsavedChangesBarProps) {
  if (!visible) return null

  return (
    <div role="region" aria-label="Unsaved changes" className="gl-unsaved-bar">
      <span className={`gl-unsaved-bar__message${error ? " is-error" : ""}`} role={error ? "alert" : undefined}>
        <span className="gl-unsaved-bar__dot" aria-hidden="true" />
        {error ?? message}
      </span>
      <Button variant="secondary" onClick={onDiscard} disabled={saving}>
        Discard
      </Button>
      <Button variant="primary" onClick={onSave} loading={saving}>
        {saveLabel}
      </Button>
    </div>
  )
}

import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import Button from "@gl-admin/components/ui/Button"
import Input from "@gl-admin/components/ui/Input"
import RadioGroup from "@gl-admin/components/ui/RadioGroup"
import Notice from "@gl-admin/components/ui/Notice"
import { errorMessage } from "@gl-admin/lib/api/errors"
import "@gl-admin/assets/styles/pages/global-styles.scss"
import { checkNewName } from "@gl-admin/lib/siteDesign"
import type { SiteTemplateKind } from "@gl-admin/lib/api/siteDesign"

// The Site editor's dialogs (#493; the boards "Publish site design, reset & discard" and
// "New template & the page Template field"): a confirmation that runs an action and says
// when it failed, and New page template / New part.

/** Asks first, runs `onConfirm`, and keeps the dialog open with the error if it fails. */
export function ConfirmDialog({
  isOpen,
  onClose,
  title,
  children,
  confirmLabel,
  danger = false,
  onConfirm,
}: {
  isOpen: boolean
  onClose: () => void
  title: string
  children: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    if (isOpen) setFailure(null)
  }, [isOpen])
  const confirm = async () => {
    setBusy(true)
    setFailure(null)
    try {
      await onConfirm()
      onClose()
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      isOpen={isOpen}
      onClose={busy ? () => {} : onClose}
      title={title}
      size="small"
      footer={
        <div className="gl-styles-dialog__footer">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={() => void confirm()} loading={busy}>
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <div className="gl-styles-dialog">
        {children}
        {failure && (
          <Notice tone="danger" live="alert">
            {failure}
          </Notice>
        )}
      </div>
    </Modal>
  )
}

/**
 * New page template (`custom-<name>`, design 10, 13.1) or New part: the name, saved as the
 * rule makes it (shown as it's typed); a page template starts from the theme's page or blank,
 * a part starts empty. `taken` is the theme's slugs of that kind.
 */
export function NewTemplateDialog({
  isOpen,
  onClose,
  kind,
  themeName,
  taken,
  onCreate,
}: {
  isOpen: boolean
  onClose: () => void
  kind: SiteTemplateKind
  themeName: string
  taken: ReadonlySet<string>
  onCreate: (input: { slug: string; title: string; from: "starter" | "blank" }) => Promise<void>
}) {
  const [typed, setTyped] = useState("")
  const [from, setFrom] = useState<"starter" | "blank">("starter")
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  useEffect(() => {
    if (!isOpen) return
    setTyped("")
    setFrom("starter")
    setFailure(null)
    setSubmitted(false)
  }, [isOpen])

  const check = checkNewName(typed, kind, taken, themeName)
  const isPart = kind === "part"
  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    setSubmitted(true)
    if (!check.ok) return
    setBusy(true)
    setFailure(null)
    try {
      await onCreate({ slug: check.slug, title: typed.trim(), from: isPart ? "blank" : from })
      onClose()
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  const error = check.ok ? null : (check.error ?? (submitted ? "Give it a name." : null))
  const hint = check.ok ? (
    <>
      Saved as <code>{check.slug}</code>.{" "}
      {isPart ? "Templates find a part by this name." : "Pages keep this name, so it can’t be changed later."}
    </>
  ) : isPart ? (
    "Templates find a part by its name."
  ) : (
    "Pages keep its name, so it can’t be changed later."
  )

  return (
    <Modal
      isOpen={isOpen}
      onClose={busy ? () => {} : onClose}
      title={isPart ? "New template part" : "New page template"}
      size="small"
      footer={
        <div className="gl-styles-dialog__footer">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!check.ok}>
            {isPart ? "Create part" : "Create template"}
          </Button>
        </div>
      }
    >
      <form className="gl-styles-dialog" onSubmit={(event) => void submit(event)} noValidate>
        <Input title="Name" value={typed} onChange={(event) => setTyped(event.target.value)} unmasked autoFocus hint={hint} error={error} maxLength={200} />
        {isPart ? (
          <p className="gl-styles-dialog__hint">It starts empty. Add it to a template with the Template part block.</p>
        ) : (
          <>
            <RadioGroup
              legend="Start from"
              variant="card"
              value={from}
              onChange={(value) => setFrom(value as "starter" | "blank")}
              options={[
                { value: "starter", label: `${themeName}’s page`, description: "A block version of how pages look now: header, title, content, footer." },
                { value: "blank", label: "Blank", description: "An empty template. It needs blocks before it can be published." },
              ]}
            />
            <p className="gl-styles-dialog__hint">It’s offered in a page’s Template field after you publish the site design.</p>
          </>
        )}
        {failure && (
          <Notice tone="danger" live="alert">
            {failure}
          </Notice>
        )}
      </form>
    </Modal>
  )
}

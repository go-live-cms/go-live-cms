import { useEffect, useState } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import Input from "@gl-admin/components/ui/Input"
import Checkbox from "@gl-admin/components/ui/Checkbox"
import Button from "@gl-admin/components/ui/Button"
import Notice from "@gl-admin/components/ui/Notice"
import { toast } from "@gl-admin/components/ui/Toast"
import { createPostTemplate } from "@gl-admin/lib/api/postTemplates"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { TEMPLATE_NAME_MAX, savedTemplateMessage, templateNameConflict, templateNameError } from "@gl-admin/lib/postTemplates"

// "Save as template…" (#322), from a post's row menu (admins and editors): the post's
// content as it is now (the API asks the collab server for the last edits first),
// under a name, for new posts of its type. Optionally its category and featured image.

type SaveTemplateDialogProps = {
  isOpen: boolean
  post: { id: number; title: string }
  // "post" or "page": the post type's singular, in the wording.
  noun?: string
  onClose: () => void
}

const FORM_ID = "gl-save-template-form"
const inputValue = (e: any): string => e.currentTarget?.value ?? e.target?.value ?? ""

export default function SaveTemplateDialog({ isOpen, post, noun = "post", onClose }: SaveTemplateDialogProps) {
  const [name, setName] = useState("")
  const [withSettings, setWithSettings] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    setName(Array.from(post.title.trim()).slice(0, TEMPLATE_NAME_MAX).join(""))
    setWithSettings(false)
    setNameError(null)
    setError(null)
    setSaving(false)
  }, [isOpen, post.id, post.title])

  if (!isOpen) return null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const invalid = templateNameError(name)
    setNameError(invalid)
    setError(null)
    if (invalid) return
    setSaving(true)
    try {
      await createPostTemplate({ post_id: post.id, name: name.trim(), with_settings: withSettings })
      toast.success(savedTemplateMessage(name))
      onClose()
    } catch (err) {
      const conflict = templateNameConflict(err, name, noun)
      if (conflict) setNameError(conflict)
      else setError(errorMessage(err, "Couldn't save the template."))
      setSaving(false)
    }
  }

  return (
    <Modal
      isOpen
      onClose={() => !saving && onClose()}
      title="Save as template"
      description={`New ${noun}s can start from its content, as it is now. Later edits to this ${noun} don't change the template.`}
      size="medium"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" type="submit" form={FORM_ID} loading={saving}>
            Save template
          </Button>
        </>
      }
    >
      <form id={FORM_ID} className="gl-template-form" onSubmit={submit} noValidate>
        <Input
          id="gl-save-template-name"
          title="Template name"
          name="name"
          unmasked
          maxLength={TEMPLATE_NAME_MAX}
          value={name}
          error={nameError ?? undefined}
          onChange={(e: any) => setName(inputValue(e))}
        />
        <Checkbox
          label="Also save its category and featured image"
          description={`New ${noun}s from it start with them.`}
          checked={withSettings}
          onChange={setWithSettings}
        />
        {error && (
          <Notice tone="danger" live="alert">
            {error}
          </Notice>
        )}
      </form>
    </Modal>
  )
}

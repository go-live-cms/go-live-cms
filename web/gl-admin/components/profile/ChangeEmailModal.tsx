import { useEffect, useState } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import Input from "@gl-admin/components/ui/Input"
import Button from "@gl-admin/components/ui/Button"
import Notice from "@gl-admin/components/ui/Notice"
import { requestEmailChange } from "@gl-admin/lib/api/users"
import {
  describeEmailChangeError,
  emailChangeSentMessage,
  validateEmailChange,
  type EmailChangeFields,
} from "@gl-admin/lib/profile"
import "@gl-admin/assets/styles/components/users/invitations.scss"

interface ChangeEmailModalProps {
  isOpen: boolean
  currentEmail: string
  onClose: () => void
  // The message to show on the profile once the link is on its way.
  onSent: (message: string) => void
}

const FORM_ID = "gl-change-email-form"
const EMPTY: EmailChangeFields = { new_email: "", current_password: "" }
const inputValue = (e: any): string => e.currentTarget?.value ?? e.target?.value ?? ""

// Change email (#334): the API emails a link to the new address and changes nothing
// until it's opened; the old address is told afterwards. It answers the same way
// whether or not another account uses the address, so this never says so either.
export default function ChangeEmailModal({ isOpen, currentEmail, onClose, onSent }: ChangeEmailModalProps) {
  const [fields, setFields] = useState<EmailChangeFields>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (isOpen) {
      setFields(EMPTY)
      setError(null)
      setSending(false)
    }
  }, [isOpen])

  if (!isOpen) return null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const invalid = validateEmailChange(fields, currentEmail)
    if (invalid) {
      setError(invalid)
      return
    }
    setError(null)
    setSending(true)
    try {
      const response = await requestEmailChange(fields.current_password, fields.new_email.trim())
      onSent(emailChangeSentMessage(fields.new_email, response?.expires_in_seconds))
    } catch (err) {
      setError(describeEmailChangeError(err))
      setSending(false)
    }
  }

  return (
    <Modal
      isOpen
      onClose={() => !sending && onClose()}
      title="Change email"
      description="We'll send a link to the new address. Your email stays the same until you open it."
      size="medium"
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" type="submit" form={FORM_ID} loading={sending}>
            Send link
          </Button>
        </>
      }
    >
      <form id={FORM_ID} className="gl-invite-form" onSubmit={submit} noValidate>
        <Input
          // Own ids: the profile's password form has a current_password field too.
          id="gl-change-email-new"
          title="New email"
          type="email"
          name="new_email"
          autoComplete="email"
          unmasked
          value={fields.new_email}
          onChange={(e: any) => setFields((prev) => ({ ...prev, new_email: inputValue(e) }))}
        />
        <Input
          id="gl-change-email-password"
          title="Current password"
          type="password"
          name="current_password"
          autoComplete="current-password"
          unmasked
          value={fields.current_password}
          onChange={(e: any) => setFields((prev) => ({ ...prev, current_password: inputValue(e) }))}
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

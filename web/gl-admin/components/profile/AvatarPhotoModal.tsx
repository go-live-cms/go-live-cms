import { useEffect, useState } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import Button from "@gl-admin/components/ui/Button"
import Notice from "@gl-admin/components/ui/Notice"
import FocalPointPicker from "@gl-admin/components/media/FocalPointPicker"
import { uploadAvatar } from "@gl-admin/lib/api/users"
import type { User } from "@gl-admin/lib/api/types"
import type { FocalPoint } from "@gl-admin/lib/types"
import { focalObjectPosition } from "@gl-admin/lib/mediaLibrary"
import { describeAvatarError } from "@gl-admin/lib/profile"

interface AvatarPhotoModalProps {
  // The picked file; null keeps the dialog closed.
  file: File | null
  onClose: () => void
  onSaved: (user: User) => void
}

const CENTER: FocalPoint = { x: 0.5, y: 0.5 }

// Crop for the profile photo (#334): the API keeps the largest square around the
// point picked here (the media focal point picker), so the round preview shows what
// everyone will see. Nothing is uploaded until "Save photo".
export default function AvatarPhotoModal({ file, onClose, onSaved }: AvatarPhotoModalProps) {
  const [focal, setFocal] = useState<FocalPoint>(CENTER)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // An object URL for the preview, made and revoked in the same effect (StrictMode
  // runs it twice in dev), so it never points at a revoked URL.
  const [preview, setPreview] = useState<string | null>(null)
  useEffect(() => {
    setFocal(CENTER)
    setError(null)
    setSaving(false)
    if (!file) {
      setPreview(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  if (!file || !preview) return null

  const save = async () => {
    setError(null)
    setSaving(true)
    try {
      const { user } = await uploadAvatar(file, focal)
      onSaved(user)
    } catch (err) {
      setError(describeAvatarError(err))
      setSaving(false)
    }
  }

  return (
    <Modal
      isOpen
      onClose={() => !saving && onClose()}
      title="Profile photo"
      description="Click the part of the photo to keep in the circle."
      size="medium"
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" onClick={save} loading={saving}>
            Save photo
          </Button>
        </>
      }
    >
      <div className="gl-profile-photo">
        <FocalPointPicker src={preview} alt="Your new photo" value={focal} onChange={setFocal} className="gl-profile-photo__picker" />
        <figure className="gl-profile-photo__preview">
          <img src={preview} alt="" style={{ objectPosition: focalObjectPosition(focal) }} data-testid="avatar-preview" />
          <figcaption>Preview</figcaption>
        </figure>
      </div>
      {error && (
        <Notice tone="danger" live="alert">
          {error}
        </Notice>
      )}
    </Modal>
  )
}

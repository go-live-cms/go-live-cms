import React from "react"
import Modal from "@gl-admin/components/ui/Modal"
import type { Media } from "@gl-admin/lib/types"

interface MediaEditModalProps {
  isOpen: boolean
  onClose: () => void
  media: Media | null
}

const MediaEditModal: React.FC<MediaEditModalProps> = ({ isOpen, onClose, media }) => {
  if (!media) return null

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Edit: ${media.name}`} size="large">
      <div className="media-edit-modal">
        <h3>Editing Media: {media.name}</h3>
        <p>File Size: {media.file_size} bytes</p>
        <p>Type: {media.mime_type}</p>
        <p>Created: {new Date(media.created_at).toLocaleDateString()}</p>

        <div
          style={{
            padding: "2rem",
            borderRadius: "8px",
            margin: "1rem 0",
            textAlign: "center",
          }}
        >
          <h4>Coming soon</h4>
          <p>Media editing functionality will be implemented here.</p>
          <p>
            <strong>Media ID:</strong> {media.id}
          </p>
          <p>
            <strong>Path:</strong> {media.media_path}
          </p>
        </div>
      </div>
    </Modal>
  )
}

export default MediaEditModal

import { useCallback, useEffect, useState } from "react"
import type { Editor as TiptapEditor } from "@tiptap/core"
import MediaPicker from "@gl-admin/components/media/MediaPicker"
import { createPostMedia } from "@gl-admin/lib/api/posts"
import type { Media } from "@gl-admin/lib/api/types"
import { MediaBlockManager } from "../blocks/mediaBlocks"
import { chooseMediaFor, registerMediaPickerHost, type MediaPickRequest } from "../blocks/mediaPicking"

/**
 * The editor's media picker (#423): shows the shared `MediaPicker` whenever a media block
 * asks for one (`mediaPicking.ts`: Choose from Media, Replace) or an image placeholder is
 * clicked. Mounted for an editable editor only. A chosen file is also linked to the post at
 * once (best effort, as the image block always did); the collab store's media sync keeps the
 * links in step with the blocks.
 */
export default function MediaPickerHost({ editor, postId }: { editor: TiptapEditor | null; postId?: number }) {
  const [request, setRequest] = useState<MediaPickRequest | null>(null)

  useEffect(() => {
    if (!editor) return
    const unregister = registerMediaPickerHost(editor, setRequest)
    const placeholders = new MediaBlockManager(editor, (pos) => chooseMediaFor(editor, pos))
    return () => {
      unregister()
      placeholders.destroy()
    }
  }, [editor])

  const close = useCallback(() => setRequest(null), [])

  const select = useCallback(
    (media: Media | null) => {
      if (!media || !request) return
      request.onPick(media)
      if (postId) {
        createPostMedia(postId, media.id, 1).catch((error) => console.error("Failed to link media to post:", error))
      }
    },
    [request, postId]
  )

  return <MediaPicker isOpen={request !== null} onClose={close} onSelect={select} kind={request?.kind} current={request?.current ?? null} />
}

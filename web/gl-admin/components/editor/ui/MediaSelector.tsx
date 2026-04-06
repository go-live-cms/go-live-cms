import { useEffect, useState, useCallback, useMemo } from "react"
import FeaturedImageSelector from "./FeaturedImageSelector"
import { MediaBlockManager } from "../blocks/mediaBlocks"
import type { Media } from "@gl-admin/lib/api/types"

export default function MediaSelector({ editor, postId }) {
  const [showMediaSelector, setShowMediaSelector] = useState(false)
  const [pendingImagePosition, setPendingImagePosition] = useState<number | null>(null)
  const [mediaBlockManager, setMediaBlockManager] = useState<MediaBlockManager | null>(null)

  const handleMediaSelect = useCallback(
    async (media: Media) => {
      if (!mediaBlockManager || pendingImagePosition === null) return
      await mediaBlockManager.handleMediaSelect(media, pendingImagePosition)
      setShowMediaSelector(false)
      setPendingImagePosition(null)
    },
    [mediaBlockManager, pendingImagePosition]
  )

  const handleMediaSelectorClose = useCallback(() => {
    setShowMediaSelector(false)
    setPendingImagePosition(null)
  }, [])

  useEffect(() => {
    if (!editor) return

    const manager = new MediaBlockManager(editor, postId, (position: number) => {
      setPendingImagePosition(position)
      setShowMediaSelector(true)
    })
    setMediaBlockManager(manager)

    return () => {
      manager.destroy()
    }
  }, [editor, postId])

  if (showMediaSelector) {
    return (
      <FeaturedImageSelector
        isOpen={showMediaSelector}
        onClose={handleMediaSelectorClose}
        onSelect={handleMediaSelect}
        currentFeaturedImage={null}
      />
    )
  }
}

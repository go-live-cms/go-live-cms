import { useState, useEffect, useCallback } from "react"
import { getFeaturedImageFull, setFeaturedImage, removeFeaturedImage } from "@gl-admin/lib/api/meta"
import type { Media } from "@gl-admin/lib/api/types"

interface UseFeaturedImageReturn {
  featuredImage: Media | null
  loading: boolean
  error: string | null
  setImage: (media: Media | null) => Promise<void>
  refetch: () => Promise<void>
}

export function useFeaturedImage(postId: number | undefined): UseFeaturedImageReturn {
  const [featuredImage, setFeaturedImageState] = useState<Media | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadFeaturedImage = useCallback(async () => {
    if (!postId) {
      setFeaturedImageState(null)
      return
    }

    try {
      setLoading(true)
      setError(null)
      
      const featuredImageData = await getFeaturedImageFull(postId)
      
      if (featuredImageData) {
        // Convert the response to Media format
        const media: Media = {
          id: featuredImageData.id,
          name: featuredImageData.name,
          description: featuredImageData.description,
          alt: featuredImageData.alt,
          media_path: featuredImageData.media_path,
          user_id: featuredImageData.user_id || 0,
          created_at: featuredImageData.created_at,
          changed_at: featuredImageData.changed_at,
          file_size: featuredImageData.file_size,
          mime_type: featuredImageData.mime_type,
          width: featuredImageData.width,
          height: featuredImageData.height,
          duration: featuredImageData.duration || 0,
          original_filename: featuredImageData.original_filename,
        }
        setFeaturedImageState(media)
      } else {
        setFeaturedImageState(null)
      }
    } catch (err) {
      console.error("Error loading featured image:", err)
      setError(err instanceof Error ? err.message : "Failed to load featured image")
      setFeaturedImageState(null)
    } finally {
      setLoading(false)
    }
  }, [postId])

  const setImage = useCallback(async (media: Media | null) => {
    if (!postId) {
      console.warn("Cannot set featured image: postId is undefined")
      return
    }

    try {
      setLoading(true)
      setError(null)

      if (media) {
        await setFeaturedImage(postId, media.id, media.media_path)
        setFeaturedImageState(media)
      } else {
        await removeFeaturedImage(postId)
        setFeaturedImageState(null)
      }
    } catch (err) {
      console.error("Error updating featured image:", err)
      setError(err instanceof Error ? err.message : "Failed to update featured image")
      await loadFeaturedImage()
    } finally {
      setLoading(false)
    }
  }, [postId, loadFeaturedImage])

  const refetch = useCallback(async () => {
    await loadFeaturedImage()
  }, [loadFeaturedImage])

  useEffect(() => {
    loadFeaturedImage()
  }, [loadFeaturedImage])

  return {
    featuredImage,
    loading,
    error,
    setImage,
    refetch,
  }
}

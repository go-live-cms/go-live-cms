import React, { useState, useEffect } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import { getMedia } from "@gl-admin/lib/api/media"
import { getMediaURL } from "@gl-admin/lib/api"
import type { Media } from "@gl-admin/lib/api/types"
import "@gl-admin/assets/styles/components/editor/featured-image-selector.scss"

interface FeaturedImageSelectorProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (media: Media) => void
  currentFeaturedImage?: Media | null
}

const FeaturedImageSelector: React.FC<FeaturedImageSelectorProps> = ({
  isOpen,
  onClose,
  onSelect,
  currentFeaturedImage,
}) => {
  const [mediaItems, setMediaItems] = useState<Media[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [currentPage, setCurrentPage] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const itemsPerPage = 20

  useEffect(() => {
    if (isOpen) {
      loadMedia()
    }
  }, [isOpen])

  useEffect(() => {
    if (isOpen) {
      const timeoutId = setTimeout(() => {
        loadMedia(true)
      }, 300)
      return () => clearTimeout(timeoutId)
    }
  }, [searchQuery])

  const loadMedia = async (reset: boolean = false) => {
    try {
      setLoading(true)
      setError(null)
      const page = reset ? 0 : currentPage
      
      const params = {
        limit: itemsPerPage,
        offset: page * itemsPerPage,
        sort: "date_desc" as const,
        type: "image", 
        ...(searchQuery && { search: searchQuery }),
      }

      const response = await getMedia(params)
      
      if (reset) {
        setMediaItems(response.data)
        setCurrentPage(0)
      } else {
        setMediaItems(prev => [...prev, ...response.data])
      }
      
      setHasMore(response.data.length === itemsPerPage)
      
    } catch (err) {
      console.error("Error loading media:", err)
      setError(err instanceof Error ? err.message : "Failed to load media")
    } finally {
      setLoading(false)
    }
  }

  const loadMore = () => {
    if (!loading && hasMore) {
      setCurrentPage(prev => prev + 1)
      loadMedia()
    }
  }

  const handleSelect = (media: Media) => {
    onSelect(media)
    onClose()
  }

  const handleRemove = () => {
    onSelect(null as any) 
    onClose()
  }

  const isImageFile = (media: Media) => {
    return media.mime_type?.startsWith('image/') || false
  }

  const getImageUrl = (media: Media) => {
    return getMediaURL(media.media_path)
  }

  return (
    <Modal 
      isOpen={isOpen} 
      onClose={onClose} 
      title="Select Featured Image"
      size="large"
    >
      <div className="gl-featured-image-selector">
        {}
        <div className="gl-featured-image-selector__controls">
          <div className="gl-featured-image-selector__search">
            <input
              type="text"
              placeholder="Search images..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="gl-featured-image-selector__search-input"
            />
          </div>
          
          {currentFeaturedImage && (
            <button
              onClick={handleRemove}
              className="gl-featured-image-selector__remove-btn"
            >
              Remove Featured Image
            </button>
          )}
        </div>

        {error && (
          <div className="gl-featured-image-selector__error">
            <p>Error: {error}</p>
          </div>
        )}

        <div className="gl-featured-image-selector__grid">
          {mediaItems
            .filter(isImageFile)
            .map((media) => (
            <div
              key={media.id}
              className={`gl-featured-image-selector__item ${
                currentFeaturedImage?.id === media.id ? 'gl-featured-image-selector__item--selected' : ''
              }`}
              onClick={() => handleSelect(media)}
            >
              <div className="gl-featured-image-selector__thumbnail">
                <img
                  src={getImageUrl(media)}
                  alt={media.alt || media.name}
                  loading="lazy"
                />
                
                {currentFeaturedImage?.id === media.id && (
                  <div className="gl-featured-image-selector__selected-indicator">
                    <span>✓</span>
                  </div>
                )}
              </div>
              
              <div className="gl-featured-image-selector__info">
                <p className="gl-featured-image-selector__name" title={media.name}>
                  {media.name}
                </p>
              </div>
            </div>
          ))}
        </div>

        {loading && currentPage === 0 && (
          <div className="gl-featured-image-selector__loading">
            <div className="gl-featured-image-selector__grid">
              {Array.from({ length: 12 }).map((_, index) => (
                <div key={index} className="gl-featured-image-selector__item gl-featured-image-selector__item--skeleton">
                  <div className="gl-featured-image-selector__thumbnail skeleton"></div>
                  <div className="gl-featured-image-selector__info">
                    <div className="gl-featured-image-selector__name skeleton"></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {hasMore && !loading && mediaItems.length > 0 && (
          <div className="gl-featured-image-selector__load-more">
            <button onClick={loadMore} className="gl-featured-image-selector__load-more-btn">
              Load More Images
            </button>
          </div>
        )}

        {!loading && mediaItems.filter(isImageFile).length === 0 && (
          <div className="gl-featured-image-selector__empty">
            {searchQuery ? (
              <>
                <p>No images found for "{searchQuery}"</p>
                <button onClick={() => setSearchQuery("")} className="gl-featured-image-selector__clear-search">
                  Clear Search
                </button>
              </>
            ) : (
              <p>No images available. Upload some images first.</p>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

export default FeaturedImageSelector

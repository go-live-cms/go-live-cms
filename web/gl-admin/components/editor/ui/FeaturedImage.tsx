import React, { useState, useEffect } from "react"
import FeaturedImageSelector from "./FeaturedImageSelector"
import { getMediaURL } from "@gl-admin/lib/api"
import type { Media } from "@gl-admin/lib/api/types"
import "@gl-admin/assets/styles/components/editor/featured-image.scss"

interface FeaturedImageProps {
  value?: Media | null
  onChange: (media: Media | null) => void
  postId?: number
  disabled?: boolean
}

const FeaturedImage: React.FC<FeaturedImageProps> = ({
  value,
  onChange,
  postId,
  disabled = false,
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [featuredImage, setFeaturedImage] = useState<Media | null>(value || null)

  useEffect(() => {
    setFeaturedImage(value || null)
  }, [value])

  const handleImageSelect = (media: Media | null) => {
    setFeaturedImage(media)
    onChange(media)
  }

  const handleRemove = () => {
    setFeaturedImage(null)
    onChange(null)
  }

  const openSelector = () => {
    if (!disabled) {
      setIsModalOpen(true)
    }
  }

  return (
    <div className="gl-featured-image">
      <div className="gl-featured-image__header">
        <h3 className="gl-featured-image__title">Featured Image</h3>
        {featuredImage && (
          <button
            onClick={handleRemove}
            className="gl-featured-image__remove"
            disabled={disabled}
            title="Remove featured image"
          >
            Remove
          </button>
        )}
      </div>

      <div className="gl-featured-image__content">
        {featuredImage ? (
          <div className="gl-featured-image__preview" onClick={openSelector}>
            <img
              src={getMediaURL(featuredImage.media_path)}
              alt={featuredImage.alt || featuredImage.name}
              className="gl-featured-image__image"
            />
            <div className="gl-featured-image__overlay">
              <span className="gl-featured-image__overlay-text">
                Click to change
              </span>
            </div>
            <div className="gl-featured-image__info">
              <p className="gl-featured-image__name">{featuredImage.name}</p>
              {featuredImage.width && featuredImage.height && (
                <p className="gl-featured-image__dimensions">
                  {featuredImage.width} × {featuredImage.height} pixels
                </p>
              )}
            </div>
          </div>
        ) : (
          <div
            className={`gl-featured-image__placeholder ${disabled ? 'gl-featured-image__placeholder--disabled' : ''}`}
            onClick={openSelector}
          >
            <div className="gl-featured-image__placeholder-content">
              <div className="gl-featured-image__placeholder-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                  <circle cx="8.5" cy="8.5" r="1.5"/>
                  <polyline points="21,15 16,10 5,21"/>
                </svg>
              </div>
              <p className="gl-featured-image__placeholder-text">
                {disabled ? 'No featured image' : 'Set featured image'}
              </p>
              {!disabled && (
                <p className="gl-featured-image__placeholder-hint">
                  Click to select an image
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      <FeaturedImageSelector
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSelect={handleImageSelect}
        currentFeaturedImage={featuredImage}
      />
    </div>
  )
}

export default FeaturedImage

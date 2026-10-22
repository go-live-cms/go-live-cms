import React from "react"
import type { FocalPoint } from "@gl-admin/lib/types"

// The focal point (#255) is the part of an image to keep in view when the
// public site crops it (object-fit: cover + object-position). It is stored as
// fractions of the width and height from the top-left corner.

// focalPointFromClick converts a click inside the image's box to a focal
// point, clamped to 0..1 and rounded to 3 decimals.
export function focalPointFromClick(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  clientX: number,
  clientY: number
): FocalPoint {
  const clamp = (v: number) => Math.min(1, Math.max(0, Math.round(v * 1000) / 1000))
  return {
    x: rect.width > 0 ? clamp((clientX - rect.left) / rect.width) : 0.5,
    y: rect.height > 0 ? clamp((clientY - rect.top) / rect.height) : 0.5,
  }
}

// nudgeFocalPoint moves a focal point by step in an arrow key's direction.
export function nudgeFocalPoint(point: FocalPoint | null, key: string, step = 0.05): FocalPoint | null {
  const current = point ?? { x: 0.5, y: 0.5 }
  const clamp = (v: number) => Math.min(1, Math.max(0, Math.round(v * 1000) / 1000))
  switch (key) {
    case "ArrowLeft":
      return { ...current, x: clamp(current.x - step) }
    case "ArrowRight":
      return { ...current, x: clamp(current.x + step) }
    case "ArrowUp":
      return { ...current, y: clamp(current.y - step) }
    case "ArrowDown":
      return { ...current, y: clamp(current.y + step) }
    default:
      return null
  }
}

export function formatFocalPoint(point: FocalPoint | null | undefined): string {
  if (!point) return "Not set (center)"
  return `${Math.round(point.x * 100)}% × ${Math.round(point.y * 100)}%`
}

interface Props {
  src: string
  alt: string
  value: FocalPoint | null
  // When set, clicking (or arrow keys) changes the point; otherwise the
  // marker is only shown.
  onChange?: (point: FocalPoint) => void
  className?: string
}

const FocalPointPicker: React.FC<Props> = ({ src, alt, value, onChange, className }) => {
  const editable = !!onChange

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onChange) return
    onChange(focalPointFromClick(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY))
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onChange) return
    const next = nudgeFocalPoint(value, e.key)
    if (next) {
      e.preventDefault()
      onChange(next)
    }
  }

  return (
    <div
      className={`focal-point-picker${editable ? " focal-point-picker--editable" : ""}${className ? ` ${className}` : ""}`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role={editable ? "slider" : undefined}
      tabIndex={editable ? 0 : undefined}
      aria-label={editable ? "Focal point: click the image or use the arrow keys" : undefined}
      aria-valuetext={editable ? formatFocalPoint(value) : undefined}
      data-testid="focal-point-picker"
    >
      <img src={src} alt={alt} className="focal-point-picker__image" draggable={false} />
      {value && (
        <span
          className="focal-point-picker__marker"
          style={{ left: `${value.x * 100}%`, top: `${value.y * 100}%` }}
          aria-hidden="true"
        />
      )}
    </div>
  )
}

export default FocalPointPicker

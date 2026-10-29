import type { CSSProperties } from "react"
import "@gl-admin/assets/styles/components/ui/skeleton.scss"

type SkeletonProps = {
  width?: number | string
  height?: number | string
  // text: a 12px line. circle: avatars. pill: status pills. block: anything else.
  shape?: "text" | "block" | "circle" | "pill"
  className?: string
  style?: CSSProperties
}

// A loading placeholder (never a spinner for page content). Decorative: announce the
// loading state once for the region instead (aria-busy plus a status message).
export default function Skeleton({ width, height, shape = "block", className = "", style }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={`gl-skeleton gl-skeleton--${shape} ${className}`}
      style={{ width, height, ...style }}
    />
  )
}

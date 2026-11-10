import React from "react"
import type { ContainerImage } from "./blockImage"

/** The `<img>` of a cover or media & text (#427), from `containerImageFor`. */
const ContainerImg: React.FC<{ shown: ContainerImage & { image: NonNullable<ContainerImage["image"]> } }> = ({ shown: { image, alt, eager } }) => (
  <img
    src={image.src}
    srcSet={image.srcSet}
    sizes={image.sizes}
    width={image.width}
    height={image.height}
    style={image.objectPosition ? { objectPosition: image.objectPosition } : undefined}
    loading={eager ? undefined : "lazy"}
    decoding="async"
    alt={alt}
  />
)

export default ContainerImg

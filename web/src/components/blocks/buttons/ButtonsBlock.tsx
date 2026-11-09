import React from "react"
import { isButtonVariant, normalizeButtonHref, normalizeButtonLabel } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps } from "../types"

/**
 * Buttons (#426): `div.buttons` (`is-center` when centred) of `a.btn.btn-primary` /
 * `.btn-secondary`, the theme's own button styles. The buttons come from the block's `pm`;
 * each href goes through `normalizeButtonHref` again (the same check as the API's), so a
 * doc stored before the check can't put a `javascript:` link on the page. A button with no
 * link or no label is left out: there is nothing to click, or nothing to read. A row with
 * none left renders nothing.
 */
const ButtonsBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const attrs = (block.attrs ?? {}) as { pm?: { content?: unknown }; align?: unknown }
  const stored = Array.isArray(attrs.pm?.content) ? (attrs.pm.content as any[]) : []
  const buttons = stored.flatMap((button) => {
    if (button?.type !== "button") return []
    const href = normalizeButtonHref(button.attrs?.href)
    const label = normalizeButtonLabel(
      Array.isArray(button.content) ? button.content.map((run: any) => (typeof run?.text === "string" ? run.text : "")).join("") : "",
    )
    if (!href || !label) return []
    return [{ href, label, variant: isButtonVariant(button.attrs?.variant) ? button.attrs.variant : "primary" }]
  })
  if (buttons.length === 0) return null
  return (
    <div id={anchorId} className={attrs.align === "center" ? "buttons is-center" : "buttons"}>
      {buttons.map((button, index) => (
        <a key={index} className={`btn btn-${button.variant}`} href={button.href}>
          {button.label}
        </a>
      ))}
    </div>
  )
}

export default ButtonsBlock

import Checkbox from "@gl-admin/components/ui/Checkbox"
import Textarea from "@gl-admin/components/ui/Textarea"
import { altHint } from "@gl-admin/lib/mediaLibrary"

type AltTextFieldProps = {
  id: string
  alt: string
  decorative: boolean
  onAltChange: (alt: string) => void
  onDecorativeChange: (decorative: boolean) => void
  disabled?: boolean
}

// The alt text with its "Decorative image" option (#325, the "Media detail" board), in
// the library's side panel and on the detail page. A decorative image keeps its alt text
// (unticking brings it back) but the field is off and the site renders alt="".
export default function AltTextField({ id, alt, decorative, onAltChange, onDecorativeChange, disabled = false }: AltTextFieldProps) {
  return (
    <div className="gl-media-alt">
      <Textarea
        id={id}
        label="Alt text"
        rows={3}
        value={alt}
        onChange={(e) => onAltChange(e.currentTarget.value)}
        disabled={disabled || decorative}
        hint={altHint(decorative)}
      />
      <Checkbox
        label="Decorative image"
        description="Adds nothing to the text, like a background or divider. Screen readers skip it."
        checked={decorative}
        onChange={onDecorativeChange}
        disabled={disabled}
      />
    </div>
  )
}

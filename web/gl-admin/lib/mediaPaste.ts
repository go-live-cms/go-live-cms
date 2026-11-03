// Paste to upload on the media library (#28): the rules, kept out of the page so they're
// tested on their own (mediaPaste.test.ts). The page listens for `paste` on the document
// and hands the images to its usual upload flow (same request, limits and progress tiles).

// A paste into something that takes text (the search box, the panel's fields, any
// contenteditable) is that field's, never an upload.
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest("textarea, select, [contenteditable]:not([contenteditable='false'])")) return true
  const input = target.closest("input")
  // Buttons, checkboxes and radios take no text.
  return !!input && !["button", "checkbox", "radio", "range", "color", "file", "image", "reset", "submit"].includes(input.type)
}

// Pastes the library leaves alone: into a text field, or inside a dialog (the delete
// confirmation, the phone-width panel), which isn't the library under it.
export function ignoresPaste(target: EventTarget | null): boolean {
  return isTextEntryTarget(target) || (target instanceof Element && !!target.closest("[role='dialog'], [aria-modal='true'], dialog"))
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
}

// "image/png" → "png", "image/jpeg" → "jpg".
export function imageExtension(mimeType: string): string {
  return EXTENSIONS[mimeType] ?? (mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png")
}

const pad = (n: number) => String(n).padStart(2, "0")

// pasted-20261103-142530.png, in local time: when the browser gives the clipboard image
// no name of its own.
export function pastedFileName(mimeType: string, when: Date): string {
  const stamp =
    `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-` +
    `${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`
  return `pasted-${stamp}.${imageExtension(mimeType)}`
}

// Chrome and Firefox call every image pasted from a screenshot or a web page
// "image.png" (or nothing at all); a copied file keeps its own name.
function hasOwnName(file: File): boolean {
  return !!file.name && !/^image\.[a-z0-9]+$/i.test(file.name)
}

// The images in a paste, named. Anything else on the clipboard (text, HTML, other
// files) is left out; an empty result means the paste isn't ours.
//
// Copied files (several at once from a file manager) each keep their name. An unnamed
// image is the clipboard's one picture (a screenshot, "Copy image"), which a browser may
// offer in several formats (image/png and image/tiff on macOS): only the first is kept,
// or the same picture would upload twice.
export function pastedImages(data: DataTransfer | null, when = new Date()): File[] {
  if (!data) return []
  let files: File[] = []
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  // Older browsers expose clipboard files only through `files`.
  if (files.length === 0) files = Array.from(data.files ?? [])
  let pictureTaken = false
  return files
    .filter((file) => file.type.startsWith("image/"))
    .flatMap((file) => {
      if (hasOwnName(file)) return [file]
      if (pictureTaken) return []
      pictureTaken = true
      return [new File([file], pastedFileName(file.type, when), { type: file.type, lastModified: file.lastModified })]
    })
}

import type { Media } from "@gl-admin/lib/types"

// A video's captions in the media library (#507, WCAG 1.2.2): the "Captions (VTT)" field on
// a video's detail page and side panel (`components/media/CaptionsField.tsx`). Captions
// belong to the media item, not the block: `PUT /media/:id {captions_media_id,
// captions_lang}`, and every published video block showing the video renders them as a
// <track>. Kept out of the component so the rules are tested on their own.

export const CAPTIONS_LABEL = "Captions (VTT)"

export const CAPTIONS_HELP =
  "A WebVTT file with what is said and heard in the video. Every post that shows this video gets them, without republishing. The file's name is what readers see in the player's captions menu."

export const CAPTIONS_NONE = "No captions"

// The language field's hint. Without a language the API stores the site language.
export const CAPTIONS_LANG_HELP = "The language of the captions, such as en or pt-BR."

// A BCP-47 tag in the shape a <track srclang> takes, the API's `captionsLangPattern`.
const LANG_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/

export function validCaptionsLang(tag: string): boolean {
  const value = tag.trim()
  return value.length <= 35 && LANG_PATTERN.test(value)
}

export function captionsLangError(tag: string): string | undefined {
  return validCaptionsLang(tag) ? undefined : "Use a language tag such as en or pt-BR."
}

// The API's refusals (`code` on a 400), worded for the field.
export function captionsErrorMessage(code: string | undefined): string | undefined {
  switch (code) {
    case "invalid_captions":
      return "Captions must be a WebVTT (.vtt) file in the media library."
    case "invalid_captions_lang":
      return "Use a language tag such as en or pt-BR."
    case "captions_not_video":
      return "Only a video can have captions."
    default:
      return undefined
  }
}

// What the field shows for the chosen file: its name, and "VTT · en-US".
export function captionsSummary(captions: Pick<Media, "name" | "original_filename"> | null, lang: string | undefined): { name: string; meta: string } | null {
  if (!captions) return null
  return {
    name: captions.name || captions.original_filename || "Captions",
    meta: ["VTT", lang?.trim()].filter(Boolean).join(" · "),
  }
}

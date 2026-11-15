import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { captionsErrorMessage, captionsLangError, captionsSummary, validCaptionsLang } from "./mediaCaptions"

// A video's captions in the media library (#507).

describe("the captions language", () => {
  it("accepts a BCP-47 tag in a <track srclang>'s shape, like the API", () => {
    for (const tag of ["en", "pt-BR", "zh-Hant-TW", "es-419", " en-GB "]) expect(validCaptionsLang(tag), tag).toBe(true)
    for (const tag of ["", "e", "en US", "en_GB", "english-", "-en", "en-aaaaaaaaa", `en${"-abcdefgh".repeat(4)}`, "<script>"]) {
      expect(validCaptionsLang(tag), tag).toBe(false)
    }
    expect(captionsLangError("pt-BR")).toBeUndefined()
    expect(captionsLangError("Portuguese (Brazil)")).toBe("Use a language tag such as en or pt-BR.")
  })

  it("is the API's pattern", () => {
    const go = readFileSync(resolve(__dirname, "../../../api/media_captions.go"), "utf8")
    expect(go).toContain("regexp.MustCompile(`^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$`)")
    expect(go).toContain("len(tag) <= 35")
  })
})

describe("the field", () => {
  it("names the file and says it's VTT, with its language", () => {
    expect(captionsSummary({ name: "English", original_filename: "tour-en.vtt" }, "en-US")).toEqual({ name: "English", meta: "VTT · en-US" })
    expect(captionsSummary({ name: "", original_filename: "tour-en.vtt" }, "")).toEqual({ name: "tour-en.vtt", meta: "VTT" })
    expect(captionsSummary(null, "en")).toBeNull()
  })

  it("words the API's refusals", () => {
    expect(captionsErrorMessage("invalid_captions")).toBe("Captions must be a WebVTT (.vtt) file in the media library.")
    expect(captionsErrorMessage("captions_not_video")).toBe("Only a video can have captions.")
    expect(captionsErrorMessage("invalid_captions_lang")).toBe("Use a language tag such as en or pt-BR.")
    expect(captionsErrorMessage("something_else")).toBeUndefined()
    expect(captionsErrorMessage(undefined)).toBeUndefined()
  })
})

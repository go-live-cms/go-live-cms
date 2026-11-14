import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// getSiteLanguage (#481): `<html lang>` on the account pages, which must not wait the
// settings' full 2 s timeout on a hung API. The module keeps the last language a read
// gave, so every test loads it fresh.

const api = vi.hoisted(() => ({ getSettings: vi.fn() }))
vi.mock("@/lib/api", () => ({ getSettings: api.getSettings }))

const load = async () => {
  vi.resetModules()
  return import("./siteSettings")
}
const hang = () => new Promise<never>(() => {})

beforeEach(() => {
  vi.useFakeTimers()
  api.getSettings.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("getSiteLanguage", () => {
  it("is the site language when the settings answer", async () => {
    const { getSiteLanguage } = await load()
    api.getSettings.mockResolvedValue({ site_language: "pt-BR" })
    expect(await getSiteLanguage({} as App.Locals)).toBe("pt-BR")
  })

  it("shares the request's one lookup with getSiteSettings", async () => {
    const { getSiteLanguage, getSiteSettings } = await load()
    api.getSettings.mockResolvedValue({ site_language: "fr-FR", allow_signup: true })
    const locals = {} as App.Locals
    expect((await getSiteSettings(locals)).allowSignup).toBe(true)
    expect(await getSiteLanguage(locals)).toBe("fr-FR")
    expect(api.getSettings).toHaveBeenCalledTimes(1)
  })

  it("waits LANGUAGE_WAIT_MS for a hung API, not the settings' 2 s, then takes the default", async () => {
    const { getSiteLanguage, LANGUAGE_WAIT_MS } = await load()
    api.getSettings.mockImplementation(hang)
    let language: string | undefined
    void getSiteLanguage({} as App.Locals).then((value) => (language = value))
    await vi.advanceTimersByTimeAsync(LANGUAGE_WAIT_MS - 1)
    expect(language).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(language).toBe("en-US")
  })

  it("without an answer, is the language the last successful read gave", async () => {
    const { getSiteLanguage, LANGUAGE_WAIT_MS } = await load()
    api.getSettings.mockResolvedValueOnce({ site_language: "de-DE" })
    expect(await getSiteLanguage({} as App.Locals)).toBe("de-DE")

    // Hung: the wait ends with the last language.
    api.getSettings.mockImplementationOnce(hang)
    const hung = getSiteLanguage({} as App.Locals)
    await vi.advanceTimersByTimeAsync(LANGUAGE_WAIT_MS)
    expect(await hung).toBe("de-DE")

    // Failed: not the default the failed read falls back to.
    api.getSettings.mockRejectedValueOnce(new Error("down"))
    expect(await getSiteLanguage({} as App.Locals)).toBe("de-DE")
  })

  it("a failed read before any answer is the default", async () => {
    const { getSiteLanguage } = await load()
    api.getSettings.mockRejectedValue(new Error("down"))
    expect(await getSiteLanguage({} as App.Locals)).toBe("en-US")
  })
})

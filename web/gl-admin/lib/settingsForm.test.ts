import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  EMBED_PROVIDERS,
  withEmbedProvider,
  SITE_TAGLINE_MAX,
  URL_STRUCTURES,
  changedFields,
  dateFormatOptions,
  siteAddressInfo,
  timeZoneLabel,
  timeZoneOptions,
  toDraft,
  toUpdateRequest,
  unsavedMessage,
  utcOffsetLabel,
  validateDraft,
  type SettingsDraft,
} from "./settingsForm"

// The Settings form (#343, #330): which fields are dirty and what the bar says.

const saved: SettingsDraft = {
  site_title: "GoLive Blog",
  site_tagline: "Notes from the team",
  site_language: "en-US",
  site_timezone: "America/Sao_Paulo",
  date_format: "month_day_year",
  posts_per_page: 10,
  post_url_structure: "slug",
  editor_markdown_shortcuts: true,
  editor_allowed_embeds: ["youtube"],
  allow_signup: false,
  front_page_id: null,
}

describe("allowed embeds (#425)", () => {
  it("compares the list by value, so a reload isn't a change", () => {
    expect(changedFields(saved, { ...saved, editor_allowed_embeds: ["youtube"] })).toEqual([])
    expect(changedFields(saved, { ...saved, editor_allowed_embeds: [] })).toEqual(["allowed embeds"])
  })

  it("ticks and unticks in the list's order", () => {
    expect(withEmbedProvider(["spotify"], "youtube", true)).toEqual(["youtube", "spotify"])
    expect(withEmbedProvider(["youtube", "spotify"], "youtube", false)).toEqual(["spotify"])
  })

  it("leaves out an id this build doesn't list, which the API would refuse", () => {
    const stored = { id: 1, created_at: "", changed_at: "", site_address: "", ...saved, editor_allowed_embeds: ["loom", "vimeo", "youtube"] }
    expect(toDraft(stored as never).editor_allowed_embeds).toEqual(["youtube", "vimeo"])
  })
})

describe("changedFields", () => {
  it("is empty while the draft matches what was saved", () => {
    expect(changedFields(saved, { ...saved })).toEqual([])
  })

  it("names each changed field in form order", () => {
    expect(changedFields(saved, { ...saved, post_url_structure: "id", site_title: "New" })).toEqual([
      "site title",
      "post URL structure",
    ])
    expect(
      changedFields(saved, { ...saved, editor_markdown_shortcuts: false, site_timezone: "UTC", site_tagline: "" })
    ).toEqual(["tagline", "time zone", "Markdown shortcuts"])
    expect(changedFields(saved, { ...saved, site_language: "pt-BR", date_format: "iso" })).toEqual(["language", "date format"])
    expect(changedFields(saved, { ...saved, allow_signup: true })).toEqual(["sign-up setting"])
    expect(changedFields(saved, { ...saved, posts_per_page: 5, front_page_id: 12 })).toEqual(["front page", "posts per page"])
  })

  it("is empty before the settings have loaded", () => {
    expect(changedFields(null, saved)).toEqual([])
  })
})

describe("unsavedMessage", () => {
  it("names one or two fields and counts more", () => {
    expect(unsavedMessage([])).toBe("")
    expect(unsavedMessage(["tagline"])).toBe("You changed the tagline")
    expect(unsavedMessage(["site title", "posts per page"])).toBe("You changed the site title and posts per page")
    expect(unsavedMessage(["site title", "posts per page", "post URL structure"])).toBe("You changed 3 settings")
  })
})

describe("validateDraft", () => {
  it("accepts the API's bounds", () => {
    expect(validateDraft(saved)).toBeNull()
    expect(validateDraft({ ...saved, posts_per_page: 1 })).toBeNull()
    expect(validateDraft({ ...saved, posts_per_page: 100 })).toBeNull()
    expect(validateDraft({ ...saved, site_tagline: "" })).toBeNull()
    expect(validateDraft({ ...saved, site_tagline: "é".repeat(SITE_TAGLINE_MAX) })).toBeNull()
    // Trimmed as the API stores it.
    expect(validateDraft({ ...saved, site_tagline: ` ${"x".repeat(SITE_TAGLINE_MAX)} ` })).toBeNull()
  })

  it("names the fix for an empty title or a bad page size", () => {
    expect(validateDraft({ ...saved, site_title: "" })).toBe("Enter a site title.")
    expect(validateDraft({ ...saved, site_title: "x".repeat(201) })).toMatch(/at most 200/)
    for (const n of [0, 101, Number.NaN, 2.5]) {
      expect(validateDraft({ ...saved, posts_per_page: n })).toMatch(/1 to 100/)
    }
  })

  it("refuses an over-long or multi-line tagline and a missing time zone", () => {
    expect(validateDraft({ ...saved, site_tagline: "x".repeat(SITE_TAGLINE_MAX + 1) })).toMatch(/at most 160/)
    expect(validateDraft({ ...saved, site_tagline: "one\ntwo" })).toMatch(/single line/)
    expect(validateDraft({ ...saved, site_timezone: "" })).toBe("Choose a time zone.")
  })
})

it("toDraft keeps only the edited fields", () => {
  expect(
    toDraft({
      id: 1,
      created_at: "",
      changed_at: "",
      site_address: "https://cms.example.com",
      ...saved,
    })
  ).toEqual(saved)
})

it("toUpdateRequest trims the tagline", () => {
  expect(toUpdateRequest({ ...saved, site_tagline: "  Hi  " }).site_tagline).toBe("Hi")
})

// #336: the API checks a chosen front page is published. A saved one may have been
// unpublished since; it mustn't block saving the other fields.
it("toUpdateRequest sends the front page only when it changed", () => {
  const withFront = { ...saved, front_page_id: 12 }
  expect(toUpdateRequest({ ...withFront, site_title: "New" }, withFront)).not.toHaveProperty("front_page_id")
  expect(toUpdateRequest({ ...withFront, front_page_id: null }, withFront)).toMatchObject({ front_page_id: null })
  expect(toUpdateRequest(withFront, saved)).toMatchObject({ front_page_id: 12 })
  expect(toUpdateRequest(withFront)).toMatchObject({ front_page_id: 12 })
})

describe("time zones", () => {
  const winter = new Date("2026-01-15T12:00:00Z")
  const summer = new Date("2026-07-15T12:00:00Z")

  it("labels a zone with its offset now, following daylight saving time", () => {
    expect(utcOffsetLabel("UTC", winter)).toBe("UTC")
    expect(utcOffsetLabel("America/Sao_Paulo", winter)).toBe("UTC−3")
    expect(utcOffsetLabel("America/New_York", winter)).toBe("UTC−5")
    expect(utcOffsetLabel("America/New_York", summer)).toBe("UTC−4")
    expect(utcOffsetLabel("Asia/Kathmandu", winter)).toBe("UTC+5:45")
    expect(utcOffsetLabel("Not/AZone", winter)).toBe("")
    expect(timeZoneLabel("America/Sao_Paulo", winter)).toBe("America / Sao Paulo (UTC−3)")
  })

  it("lists UTC first and keeps a saved zone the browser doesn't list", () => {
    const options = timeZoneOptions("Etc/GMT+12", winter, ["Europe/Lisbon", "UTC", "America/Sao_Paulo"])
    expect(options.map((o) => o.value)).toEqual(["UTC", "Europe/Lisbon", "America/Sao_Paulo", "Etc/GMT+12"])
  })
})

it("dateFormatOptions shows each preset in the draft's language and zone", () => {
  const sample = new Date("2026-10-27T02:00:00Z")
  expect(dateFormatOptions({ site_language: "en-US", site_timezone: "UTC" }, sample).map((o) => o.label)).toEqual([
    "October 27, 2026",
    "27 October 2026",
    "2026-10-27",
  ])
  // A day earlier in São Paulo, with Portuguese names.
  expect(dateFormatOptions({ site_language: "pt-BR", site_timezone: "America/Sao_Paulo" }, sample).map((o) => o.label)).toEqual([
    "outubro 26, 2026",
    "26 de outubro de 2026",
    "2026-10-26",
  ])
})

it("siteAddressInfo reports HTTPS", () => {
  expect(siteAddressInfo("https://cms.example.com")).toEqual({ address: "https://cms.example.com", https: true })
  expect(siteAddressInfo("http://localhost:4321")).toEqual({ address: "http://localhost:4321", https: false })
  expect(siteAddressInfo("")).toBeNull()
})

// The API's embed providers (api/settings_utils.go), next to web/ in the repo; skipped in
// the web container, which has only web/.
const SETTINGS_UTILS = path.resolve(__dirname, "../../../api/settings_utils.go")
const SETTINGS_BINDINGS = path.resolve(__dirname, "../../../api/settings_bindings.go")

describe("the API's limits", () => {
  it.skipIf(!existsSync(SETTINGS_UTILS))("EMBED_PROVIDERS are the API's embedProviders and SITE_TAGLINE_MAX its limit", () => {
    const go = readFileSync(SETTINGS_UTILS, "utf8")
    const list = go.match(/var embedProviders = \[\]string\{([^}]*)\}/)?.[1] ?? ""
    expect([...list.matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual(EMBED_PROVIDERS.map((p) => p.id))
    expect(Number(go.match(/const SiteTaglineMax = (\d+)/)?.[1])).toBe(SITE_TAGLINE_MAX)
  })

  it.skipIf(!existsSync(SETTINGS_BINDINGS))("the URL structures are the binding's oneof (#331)", () => {
    const go = readFileSync(SETTINGS_BINDINGS, "utf8")
    const oneof = go.match(/json:"post_url_structure" binding:"omitempty,oneof=([^"]+)"/)?.[1] ?? ""
    expect(URL_STRUCTURES.map((s) => s.value).sort()).toEqual(oneof.split(" ").sort())
  })

  it.skipIf(!existsSync(SETTINGS_BINDINGS))("the tagline binding uses the same max", () => {
    const go = readFileSync(SETTINGS_BINDINGS, "utf8")
    expect(go).toMatch(new RegExp(`json:"site_tagline" binding:"omitempty,max=${SITE_TAGLINE_MAX},`))
  })
})

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  DATE_FORMATS,
  DEFAULT_DATE_SETTINGS,
  SITE_LANGUAGES,
  formatSiteDate,
  normalizeDateSettings,
  siteDay,
  type DateSettings,
} from "./siteDates"

const at = (language: DateSettings["language"], timeZone: string, dateFormat: DateSettings["dateFormat"]): DateSettings => ({
  language,
  timeZone,
  dateFormat,
})

const NOON = "2026-10-27T12:00:00Z"

describe("formatSiteDate: preset × language", () => {
  it.each([
    // The language's own order when it matches the preset…
    ["en-US", "month_day_year", "long", "October 27, 2026"],
    ["en-US", "month_day_year", "short", "Oct 27, 2026"],
    ["en-GB", "day_month_year", "long", "27 October 2026"],
    ["pt-BR", "day_month_year", "long", "27 de outubro de 2026"],
    ["de-DE", "day_month_year", "long", "27. Oktober 2026"],
    ["fr-FR", "day_month_year", "long", "27 octobre 2026"],
    // …otherwise the preset's order with the language's names.
    ["en-US", "day_month_year", "long", "27 October 2026"],
    ["en-US", "day_month_year", "short", "27 Oct 2026"],
    ["en-GB", "month_day_year", "long", "October 27, 2026"],
    ["pt-BR", "month_day_year", "long", "outubro 27, 2026"],
    // ISO is the same everywhere.
    ["en-US", "iso", "long", "2026-10-27"],
    ["pt-BR", "iso", "short", "2026-10-27"],
    ["de-DE", "iso", "long", "2026-10-27"],
  ] as const)("%s %s %s → %s", (language, dateFormat, style, expected) => {
    expect(formatSiteDate(NOON, at(language, "UTC", dateFormat), style)).toBe(expected)
  })

  it("defaults to the long style and takes a Date, a string or a timestamp", () => {
    const settings = at("en-US", "UTC", "month_day_year")
    expect(formatSiteDate(new Date(NOON), settings)).toBe("October 27, 2026")
    expect(formatSiteDate(Date.parse(NOON), settings)).toBe("October 27, 2026")
  })

  it("is empty for an invalid date", () => {
    expect(formatSiteDate("not a date", DEFAULT_DATE_SETTINGS)).toBe("")
    expect(formatSiteDate(new Date(NaN), DEFAULT_DATE_SETTINGS)).toBe("")
  })
})

describe("formatSiteDate: time zone", () => {
  it("shows the day it is in the site's time zone", () => {
    // 02:00 UTC is still the evening before in São Paulo (UTC−3).
    expect(formatSiteDate("2026-10-27T02:00:00Z", at("pt-BR", "America/Sao_Paulo", "iso"))).toBe("2026-10-26")
    expect(formatSiteDate("2026-10-27T02:00:00Z", at("pt-BR", "UTC", "iso"))).toBe("2026-10-27")
    // 20:00 UTC is already the next morning in Tokyo.
    expect(formatSiteDate("2026-10-27T20:00:00Z", at("en-US", "Asia/Tokyo", "month_day_year"))).toBe("October 28, 2026")
  })

  it("follows daylight saving time: the offset changes across the switch", () => {
    const ny = at("en-US", "America/New_York", "month_day_year")
    // Before the 2026-11-01 switch New York is UTC−4: 03:30Z on Oct 31 is 23:30 on Oct 30.
    expect(formatSiteDate("2026-10-31T03:30:00Z", ny)).toBe("October 30, 2026")
    // After it, UTC−5: 04:30Z on Nov 2 is 23:30 on Nov 1 (a fixed −4 would say Nov 2).
    expect(formatSiteDate("2026-11-02T04:30:00Z", ny)).toBe("November 1, 2026")

    const london = at("en-GB", "Europe/London", "day_month_year")
    // London is UTC+0 until 2026-03-29 01:00Z, then UTC+1.
    expect(formatSiteDate("2026-03-28T23:30:00Z", london)).toBe("28 March 2026")
    expect(formatSiteDate("2026-03-29T23:30:00Z", london)).toBe("30 March 2026")
  })

  it("siteDay compares calendar days in the site's zone", () => {
    const sp = at("pt-BR", "America/Sao_Paulo", "day_month_year")
    expect(siteDay(new Date("2026-10-27T02:00:00Z"), sp)).toBe(siteDay(new Date("2026-10-26T12:00:00Z"), sp))
    expect(siteDay(new Date("2026-10-27T04:00:00Z"), sp)).not.toBe(siteDay(new Date("2026-10-26T12:00:00Z"), sp))
  })
})

describe("normalizeDateSettings", () => {
  it("keeps known values", () => {
    expect(normalizeDateSettings({ language: "pt-BR", timeZone: "America/Sao_Paulo", dateFormat: "iso" })).toEqual({
      language: "pt-BR",
      timeZone: "America/Sao_Paulo",
      dateFormat: "iso",
    })
  })

  it("falls back to the defaults for anything unknown or missing", () => {
    expect(normalizeDateSettings({})).toEqual(DEFAULT_DATE_SETTINGS)
    expect(normalizeDateSettings({ language: "xx-YY", timeZone: "Mars/Olympus_Mons", dateFormat: "yyyy" })).toEqual(
      DEFAULT_DATE_SETTINGS
    )
    expect(normalizeDateSettings({ language: 42, timeZone: "", dateFormat: null })).toEqual(DEFAULT_DATE_SETTINGS)
  })
})

// The API's lists (api/settings_utils.go and the binding's oneof), next to web/ in the
// repo. The web container only has web/, so there the check is skipped; CI runs it.
const SETTINGS_UTILS = path.resolve(__dirname, "../../../api/settings_utils.go")
const SETTINGS_BINDINGS = path.resolve(__dirname, "../../../api/settings_bindings.go")

describe("the API's lists", () => {
  it.skipIf(!existsSync(SETTINGS_UTILS))("languages are the API's siteLanguages", () => {
    const go = readFileSync(SETTINGS_UTILS, "utf8")
    const block = go.slice(go.indexOf("var siteLanguages"), go.indexOf("}\n\n", go.indexOf("var siteLanguages")))
    const tags = [...block.matchAll(/\{"([^"]+)", "[^"]+"\}/g)].map((m) => m[1])
    expect(tags).toEqual(SITE_LANGUAGES.map((l) => l.tag))
  })

  it.skipIf(!existsSync(SETTINGS_BINDINGS))("date formats are the binding's oneof", () => {
    const go = readFileSync(SETTINGS_BINDINGS, "utf8")
    const oneof = go.match(/json:"date_format" binding:"omitempty,oneof=([^"]+)"/)?.[1]
    expect(oneof?.split(" ")).toEqual([...DATE_FORMATS])
  })
})

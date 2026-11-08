import { describe, expect, it } from "vitest"
import { DATE_DIALOG_ERRORS, dateChipFromFields } from "./DateChipDialog"

// The "Date or reminder" dialog's rules (#320): what the fields insert, and why a value is refused.

const NOW = new Date("2026-11-07T12:00:00Z")

describe("dateChipFromFields", () => {
  it("inserts a date, with an optional time", () => {
    expect(dateChipFromFields({ date: "2026-11-12", time: "", remind: false }, "UTC", NOW)).toEqual({ ok: true, attrs: { date: "2026-11-12", time: null, reminder: false } })
    expect(dateChipFromFields({ date: "2026-11-12", time: "14:30", remind: false }, "UTC", NOW)).toEqual({ ok: true, attrs: { date: "2026-11-12", time: "14:30", reminder: false } })
    // A past date is fine for a plain date (a deadline that passed).
    expect(dateChipFromFields({ date: "2020-01-01", time: "", remind: false }, "UTC", NOW).ok).toBe(true)
  })

  it("gives a reminder a time (09:00 by default) that must be ahead in the site's zone", () => {
    expect(dateChipFromFields({ date: "2026-11-08", time: "", remind: true }, "UTC", NOW)).toEqual({ ok: true, attrs: { date: "2026-11-08", time: "09:00", reminder: true } })
    expect(dateChipFromFields({ date: "2026-11-07", time: "11:00", remind: true }, "UTC", NOW)).toEqual({ ok: false, field: "time", error: DATE_DIALOG_ERRORS.past })
    // 11:00 in Tokyo on Nov 7 is 02:00 UTC: passed. 23:00 there is 14:00 UTC: ahead.
    expect(dateChipFromFields({ date: "2026-11-07", time: "11:00", remind: true }, "Asia/Tokyo", NOW).ok).toBe(false)
    expect(dateChipFromFields({ date: "2026-11-07", time: "23:00", remind: true }, "Asia/Tokyo", NOW).ok).toBe(true)
  })

  it("refuses a day or time it can't store", () => {
    expect(dateChipFromFields({ date: "2026-02-30", time: "", remind: false }, "UTC", NOW)).toEqual({ ok: false, field: "date", error: DATE_DIALOG_ERRORS.date })
    expect(dateChipFromFields({ date: "", time: "", remind: false }, "UTC", NOW)).toEqual({ ok: false, field: "date", error: DATE_DIALOG_ERRORS.date })
    expect(dateChipFromFields({ date: "2026-11-12", time: "25:00", remind: false }, "UTC", NOW)).toEqual({ ok: false, field: "time", error: DATE_DIALOG_ERRORS.time })
  })
})

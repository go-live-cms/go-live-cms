import { describe, expect, it } from "vitest"
import {
  dateFieldLabel,
  defaultScheduleParts,
  formatScheduleTime,
  monthGrid,
  monthLabel,
  scheduleError,
  scheduleFailureMessage,
  scheduledPillLabel,
  scheduledUpdateErrorMessage,
  scheduledUpdateFailureMessage,
  scheduledUpdateTitle,
  timeZoneLine,
  updateScheduledPillLabel,
  weekdayLabels,
  zoneCity,
  zonedParts,
  zonedToUtc,
} from "./schedule"

// Scheduled publishing (#147): the dialog's time-zone handling and the pills. The
// zonedToUtc cases are the API's (TestSiteLocalToUTC in api/posts_schedule_test.go): the
// dialog and the server must agree on what a wall-clock time means.

const iso = (d: Date | null) => d?.toISOString().replace(".000Z", "Z") ?? null
const saoPaulo = { language: "en-US", timeZone: "America/Sao_Paulo" } as const

describe("zonedToUtc", () => {
  it.each([
    ["America/Sao_Paulo", "2026-11-03T09:00", "2026-11-03T12:00:00Z"],
    ["UTC", "2026-11-03T09:00", "2026-11-03T09:00:00Z"],
    ["America/New_York", "2026-01-15T09:00", "2026-01-15T14:00:00Z"],
    ["America/New_York", "2026-07-15T09:00", "2026-07-15T13:00:00Z"],
    // Around the spring-forward gap (02:00 → 03:00 on 2026-03-08).
    ["America/New_York", "2026-03-08T01:59", "2026-03-08T06:59:00Z"],
    ["America/New_York", "2026-03-08T03:00", "2026-03-08T07:00:00Z"],
    // Fall back: 01:30 happens twice; the first (EDT) is taken.
    ["America/New_York", "2026-11-01T01:30", "2026-11-01T05:30:00Z"],
    ["Australia/Sydney", "2026-04-05T02:30", "2026-04-04T15:30:00Z"],
    // A 30-minute shift.
    ["Australia/Lord_Howe", "2026-04-05T01:45", "2026-04-04T14:45:00Z"],
  ])("%s %s is %s", (zone, local, want) => {
    expect(iso(zonedToUtc(local, zone))).toBe(want)
  })

  it.each([
    ["America/New_York", "2026-03-08T02:30"],
    ["Australia/Sydney", "2026-10-04T02:15"],
    ["UTC", "2026-02-30T09:00"],
    ["UTC", "2026-11-03T24:00"],
    ["UTC", "tomorrow at nine"],
    ["UTC", "2026-11-03T09:00:00"],
  ])("%s %s names no instant", (zone, local) => {
    expect(zonedToUtc(local, zone)).toBeNull()
  })

  it("round-trips through zonedParts", () => {
    const at = zonedToUtc("2026-11-03T09:00", "Asia/Kathmandu")!
    expect(zonedParts(at, "Asia/Kathmandu")).toEqual({ date: "2026-11-03", time: "09:00" })
    expect(iso(at)).toBe("2026-11-03T03:15:00Z")
  })
})

describe("scheduleError", () => {
  const now = new Date("2026-03-01T12:00:00Z")

  it("accepts a later time", () => {
    expect(scheduleError("2026-03-02T09:00", "America/Sao_Paulo", now)).toBeNull()
  })

  it("refuses a time the clocks skip, naming the zone", () => {
    expect(scheduleError("2026-03-08T02:30", "America/New_York", now)).toBe(
      "That time doesn't exist in New York time: the clocks change then. Pick another."
    )
  })

  it("refuses the past, a malformed time, a date that doesn't exist and the far future", () => {
    expect(scheduleError("2026-03-01T08:59", "America/Sao_Paulo", now)).toMatch(/has passed/)
    expect(scheduleError("2026-03-02T9", "UTC", now)).toMatch(/HH:MM/)
    expect(scheduleError("2026-02-30T09:00", "UTC", now)).toBe("Pick a date that exists.")
    expect(scheduleError("2032-03-02T09:00", "UTC", now)).toMatch(/five years/)
  })

  it("uses the site's zone, not the browser's: 09:00 in São Paulo is 12:00 UTC", () => {
    const at = new Date("2026-03-02T11:30:00Z")
    expect(scheduleError("2026-03-02T09:00", "America/Sao_Paulo", at)).toBeNull()
    expect(scheduleError("2026-03-02T09:00", "UTC", at)).toMatch(/has passed/)
  })
})

describe("the time zone line", () => {
  it("names the city and the offset at the picked time", () => {
    expect(timeZoneLine("America/Sao_Paulo", new Date("2026-11-03T12:00:00Z"))).toBe("Sao Paulo time (UTC−3), from Settings.")
    expect(timeZoneLine("America/New_York", new Date("2026-01-15T14:00:00Z"))).toBe("New York time (UTC−5), from Settings.")
    // DST: the same zone in July.
    expect(timeZoneLine("America/New_York", new Date("2026-07-15T13:00:00Z"))).toBe("New York time (UTC−4), from Settings.")
    expect(timeZoneLine("UTC")).toBe("UTC, from Settings.")
    expect(zoneCity("America/Argentina/Buenos_Aires")).toBe("Buenos Aires")
  })
})

describe("pills", () => {
  const now = new Date("2026-11-01T12:00:00Z")

  it("show the day in the site's zone", () => {
    expect(scheduledPillLabel("2026-11-03T12:00:00Z", saoPaulo, { now })).toBe("Scheduled · Nov 3")
    // 01:30 UTC on the 4th is still the 3rd in São Paulo.
    expect(scheduledPillLabel("2026-11-04T01:30:00Z", saoPaulo, { now })).toBe("Scheduled · Nov 3")
    expect(scheduledPillLabel("2026-11-04T01:30:00Z", { language: "en-US", timeZone: "UTC" }, { now })).toBe("Scheduled · Nov 4")
  })

  it("add the time in the editor, and the year when it isn't this one", () => {
    expect(scheduledPillLabel("2026-11-04T01:30:00Z", saoPaulo, { now, withTime: true })).toBe("Scheduled · Nov 3, 22:30")
    expect(formatScheduleTime("2027-01-05T12:00:00Z", saoPaulo, { now })).toBe("Jan 5, 2027")
    expect(formatScheduleTime("2026-11-03T12:00:00Z", { language: "pt-BR", timeZone: "America/Sao_Paulo" }, { now })).toBe("3 de nov.")
  })

  it("fall back to the bare status without a time", () => {
    expect(scheduledPillLabel(null, saoPaulo)).toBe("Scheduled")
    expect(scheduledPillLabel("not a date", saoPaulo)).toBe("Scheduled")
  })
})

describe("the calendar", () => {
  it("lays a month out Sunday first", () => {
    const rows = monthGrid(2026, 10) // November 2026 starts on a Sunday
    expect(rows).toHaveLength(5)
    expect(rows[0][0]).toEqual({ date: "2026-11-01", day: 1 })
    expect(rows[4].filter(Boolean).map((d) => d!.day)).toEqual([29, 30])
    const feb = monthGrid(2026, 1) // February 2026 starts on a Sunday too, 28 days
    expect(feb).toHaveLength(4)
    const oct = monthGrid(2026, 9) // October 2026 starts on a Thursday
    expect(oct[0].slice(0, 4)).toEqual([null, null, null, null])
  })

  it("labels days, months and weekdays in the site's language", () => {
    expect(dateFieldLabel("2026-11-03")).toBe("Tue, Nov 3, 2026")
    expect(monthLabel(2026, 10)).toBe("November 2026")
    expect(weekdayLabels()).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"])
  })

  it("starts from the current schedule, else tomorrow at 09:00 site time", () => {
    expect(defaultScheduleParts("2026-11-04T01:30:00Z", "America/Sao_Paulo")).toEqual({ date: "2026-11-03", time: "22:30" })
    // 23:00 UTC on the 2nd is 20:00 in São Paulo: tomorrow is the 3rd there.
    expect(defaultScheduleParts(null, "America/Sao_Paulo", new Date("2026-11-02T23:00:00Z"))).toEqual({ date: "2026-11-03", time: "09:00" })
    expect(defaultScheduleParts(null, "Asia/Tokyo", new Date("2026-11-02T23:00:00Z"))).toEqual({ date: "2026-11-04", time: "09:00" })
  })
})

describe("scheduleFailureMessage", () => {
  const now = new Date("2026-11-03T12:00:00Z")
  it("says why and when it's tried again, in site time", () => {
    expect(scheduleFailureMessage({ reason: "collab_flush_failed", next_attempt_at: "2026-11-03T12:05:00Z" }, saoPaulo, now)).toBe(
      "The server couldn't save the latest edits, so the post wasn't published at its time. It's tried again automatically, next at 09:05."
    )
    expect(scheduleFailureMessage({ reason: "publish_failed", next_attempt_at: "2026-11-03T11:59:00Z" }, saoPaulo, now)).toBe(
      "The post couldn't be published at its time. Trying again now."
    )
  })
})

// Scheduled updates (#335): the pill, the notice's title, a failed attempt and the
// API's refusals.
describe("scheduled update text", () => {
  const now = new Date("2026-11-03T12:00:00Z")
  it("names the update's time in site time", () => {
    expect(updateScheduledPillLabel("2026-11-04T01:30:00Z", saoPaulo, { now })).toBe("Update scheduled · Nov 3")
    expect(updateScheduledPillLabel("2026-11-04T01:30:00Z", saoPaulo, { now, withTime: true })).toBe("Update scheduled · Nov 3, 22:30")
    expect(updateScheduledPillLabel(null, saoPaulo)).toBe("Update scheduled")
    expect(scheduledUpdateTitle("2026-11-03T12:00:00Z", saoPaulo, now)).toBe("Update scheduled for Nov 3, 09:00")
  })

  it("says a failed update is retried, and when", () => {
    expect(scheduledUpdateFailureMessage({ next_attempt_at: "2026-11-03T12:05:00Z" }, saoPaulo, now)).toBe(
      "The update couldn't be published at its time; the live post is unchanged. It's tried again automatically, next at 09:05."
    )
    expect(scheduledUpdateFailureMessage({ next_attempt_at: null }, saoPaulo, now)).toContain("Trying again now.")
  })

  it("explains the API's codes, else keeps its message", () => {
    expect(scheduledUpdateErrorMessage("no_unpublished_changes", "x")).toContain("nothing to update")
    expect(scheduledUpdateErrorMessage("not_scheduled", "x")).toContain("No update is scheduled")
    expect(scheduledUpdateErrorMessage(undefined, "The time has passed")).toBe("The time has passed")
  })
})
import { DEFAULT_DATE_SETTINGS, type DateSettings } from "@/lib/siteDates"
import { utcOffsetLabel } from "@gl-admin/lib/settingsForm"

// Scheduled publishing (#147): the rules behind the Schedule dialog and the "Scheduled ·
// Nov 3" pills, as data so they're testable. Times are picked and shown in the site's time
// zone (#330, Settings › General); the API stores the instant in UTC.
//
// The dialog sends the wall-clock time ("2026-11-03T09:00") and the API converts it with the
// site's zone (api/posts_schedule.go, siteLocalToUTC). zonedToUtc here follows the same
// rules, so the dialog can say before sending when a time doesn't exist or has passed: a
// time the clocks skip (spring forward) is refused, one that happens twice (fall back) is
// the first.

// A wall-clock time to the minute: what the API's `local` takes.
export type LocalDateTime = `${string}T${string}`

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
// The API refuses times further out (maxScheduleAhead).
export const MAX_SCHEDULE_AHEAD_MS = 5 * 366 * DAY

const partsFormats = new Map<string, Intl.DateTimeFormat>()
function partsFormat(zone: string): Intl.DateTimeFormat {
  let format = partsFormats.get(zone)
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
    partsFormats.set(zone, format)
  }
  return format
}

// The date ("2026-11-03") and time ("09:00") an instant is in zone.
export function zonedParts(instant: Date, zone: string): { date: string; time: string } {
  const parts = partsFormat(zone).formatToParts(instant)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ""
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` }
}

export function joinLocal(date: string, time: string): LocalDateTime {
  return `${date}T${time}` as LocalDateTime
}

// zone's offset from UTC at instant, in ms (UTC−3 → −3h).
function offsetAt(zone: string, instant: number): number {
  const { date, time } = zonedParts(new Date(instant), zone)
  const [y, mo, d] = date.split("-").map(Number)
  const [h, mi] = time.split(":").map(Number)
  const wall = Date.UTC(y, mo - 1, d, h, mi)
  return wall - Math.floor(instant / MINUTE) * MINUTE
}

// The instant a wall-clock time in zone names: null for a malformed value or a time the
// clocks skip; the earlier one for a time that happens twice. Mirrors the API.
export function zonedToUtc(local: string, zone: string): Date | null {
  const m = LOCAL_RE.exec(local)
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  const wall = Date.UTC(y, mo - 1, d, h, mi)
  // Not a real calendar date (Feb 30) or time (25:00).
  const check = new Date(wall)
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || check.getUTCHours() !== h) return null

  // Every offset the zone has within a day of it; a zone changes at most once in that time.
  const offsets = new Set([offsetAt(zone, wall - DAY), offsetAt(zone, wall), offsetAt(zone, wall + DAY)])
  const matches = [...offsets]
    .map((offset) => wall - offset)
    .filter((candidate) => {
      const parts = zonedParts(new Date(candidate), zone)
      return joinLocal(parts.date, parts.time) === local
    })
  if (matches.length === 0) return null
  return new Date(Math.min(...matches))
}

// What's wrong with a time picked in the dialog, or null when the API will take it.
export function scheduleError(local: string, zone: string, now: Date = new Date()): string | null {
  if (!LOCAL_RE.test(local)) return "Pick a date and a time (HH:MM)."
  const instant = zonedToUtc(local, zone)
  if (!instant) {
    // Well-formed but no such instant: the clocks skip it (or the date doesn't exist).
    const [date] = local.split("T")
    if (!zonedToUtc(`${date}T12:00`, zone)) return "Pick a date that exists."
    return `That time doesn't exist in ${zoneCity(zone)} time: the clocks change then. Pick another.`
  }
  if (instant.getTime() <= now.getTime()) return "That time has passed. Pick a later one, or publish now."
  if (instant.getTime() > now.getTime() + MAX_SCHEDULE_AHEAD_MS) return "Pick a time within the next five years."
  return null
}

// "America/Sao_Paulo" → "Sao Paulo"; "UTC" stays.
export function zoneCity(zone: string): string {
  if (zone === "UTC" || zone === "Etc/UTC") return "UTC"
  return (zone.split("/").pop() ?? zone).replace(/_/g, " ")
}

// The dialog's line under the calendar: "Sao Paulo time (UTC−3), from Settings." The
// offset is the one at the picked time, so it says when DST applies.
export function timeZoneLine(zone: string, at: Date = new Date()): string {
  if (zoneCity(zone) === "UTC") return "UTC, from Settings."
  return `${zoneCity(zone)} time (${utcOffsetLabel(zone, at)}), from Settings.`
}

// The dialog's starting point: the current schedule, else tomorrow at 09:00 site time.
export function defaultScheduleParts(publishAt: string | null | undefined, zone: string, now: Date = new Date()): { date: string; time: string } {
  if (publishAt) {
    const at = new Date(publishAt)
    if (!Number.isNaN(at.getTime())) return zonedParts(at, zone)
  }
  return { date: zonedParts(new Date(now.getTime() + DAY), zone).date, time: "09:00" }
}

// A calendar date (no time zone involved), formatted in the site's language.
function calendarDate(date: string, language: string, options: Intl.DateTimeFormatOptions): string {
  const [y, m, d] = date.split("-").map(Number)
  return new Intl.DateTimeFormat(language, { ...options, timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d, 12)))
}

// The Date field: "Tue, Nov 3, 2026".
export function dateFieldLabel(date: string, language: string = DEFAULT_DATE_SETTINGS.language): string {
  return calendarDate(date, language, { weekday: "short", month: "short", day: "numeric", year: "numeric" })
}

// The calendar's heading: "November 2026".
export function monthLabel(year: number, month: number, language: string = DEFAULT_DATE_SETTINGS.language): string {
  return calendarDate(`${year}-${String(month + 1).padStart(2, "0")}-01`, language, { month: "long", year: "numeric" })
}

export type CalendarDay = { date: string; day: number } | null

// One month as calendar rows of seven, Sunday first; null pads the first and last row.
export function monthGrid(year: number, month: number): CalendarDay[][] {
  const first = new Date(Date.UTC(year, month, 1))
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const cells: CalendarDay[] = Array(first.getUTCDay()).fill(null)
  for (let day = 1; day <= days; day++) {
    cells.push({ date: `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`, day })
  }
  while (cells.length % 7) cells.push(null)
  const rows: CalendarDay[][] = []
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7))
  return rows
}

// The weekday names over the calendar, Sunday first: "Sun", "Mon", ….
export function weekdayLabels(language: string = DEFAULT_DATE_SETTINGS.language): string[] {
  // 2026-11-01 is a Sunday.
  return Array.from({ length: 7 }, (_, i) => calendarDate(`2026-11-0${i + 1}`, language, { weekday: "short" }))
}

// When a scheduled post publishes, in the site's zone: "Nov 3" (lists), "Nov 3, 09:00"
// (the editor). The year is added when it isn't this year's.
export function formatScheduleTime(
  publishAt: string | Date,
  settings: Pick<DateSettings, "language" | "timeZone">,
  { withTime = false, now = new Date() }: { withTime?: boolean; now?: Date } = {}
): string {
  const at = publishAt instanceof Date ? publishAt : new Date(publishAt)
  if (Number.isNaN(at.getTime())) return ""
  const { language, timeZone } = settings
  const sameYear = zonedParts(at, timeZone).date.slice(0, 4) === zonedParts(now, timeZone).date.slice(0, 4)
  const day = new Intl.DateTimeFormat(language, {
    timeZone,
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(at)
  return withTime ? `${day}, ${zonedParts(at, timeZone).time}` : day
}

// The status pill's text: "Scheduled · Nov 3" for a scheduled post with its time.
export function scheduledPillLabel(
  publishAt: string | null | undefined,
  settings: Pick<DateSettings, "language" | "timeZone">,
  options: { withTime?: boolean; now?: Date } = {}
): string {
  const when = publishAt ? formatScheduleTime(publishAt, settings, options) : ""
  return when ? `Scheduled · ${when}` : "Scheduled"
}

// The editor's "Scheduled publish failed" notice: why, and when it's tried again.
export function scheduleFailureMessage(
  failure: { reason: string; next_attempt_at: string | null },
  settings: Pick<DateSettings, "language" | "timeZone">,
  now: Date = new Date()
): string {
  const why =
    failure.reason === "collab_flush_failed"
      ? "The server couldn't save the latest edits, so the post wasn't published at its time."
      : "The post couldn't be published at its time."
  const next = failure.next_attempt_at ? new Date(failure.next_attempt_at) : null
  if (!next || Number.isNaN(next.getTime()) || next.getTime() <= now.getTime()) return `${why} Trying again now.`
  return `${why} It's tried again automatically, next at ${zonedParts(next, settings.timeZone).time}.`
}

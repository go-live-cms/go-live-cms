import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import Button from "@gl-admin/components/ui/Button"
import { FieldError } from "@gl-admin/components/ui/Input"
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon, InfoIcon } from "@gl-admin/components/ui/icons"
import {
  dateFieldLabel,
  defaultScheduleParts,
  joinLocal,
  monthGrid,
  monthLabel,
  scheduleError,
  timeZoneLine,
  weekdayLabels,
  zonedParts,
  zonedToUtc,
} from "@gl-admin/lib/schedule"
import type { DateSettings } from "@/lib/siteDates"
import "@gl-admin/assets/styles/components/editor/schedule-dialog.scss"

// The Schedule dialog (#147, "Schedule update dialog" on the redesign canvas, which #335's
// "Schedule update" shares): date, time, a month calendar and the site's time zone. Times
// are in the site's zone (Settings › General); the API converts them (lib/schedule.ts).
// mode "update" (#335) schedules a published post's Update: the content is frozen when
// it's scheduled, so the dialog says later changes aren't included.

type ScheduleDialogProps = {
  isOpen: boolean
  onClose: () => void
  // The current schedule (Reschedule), else null.
  publishAt: string | null
  // The site's zone and language. Until `loaded`, the zone isn't known and nothing can be
  // scheduled: the API converts the time with the real one, so guessing UTC here would
  // show and check a different time than the one stored.
  settings: Pick<DateSettings, "language" | "timeZone"> & { loaded?: boolean }
  // Sends the wall-clock time ("2026-11-03T09:00"); a rejection's message is shown.
  onSchedule: (local: string) => Promise<void>
  // "publish" (a draft's first publish, #147) or "update" (a published post's, #335).
  mode?: ScheduleMode
  now?: () => Date
}

export type ScheduleMode = "publish" | "update"

// The dialog's words per mode, rescheduling or not.
export function scheduleDialogText(mode: ScheduleMode, rescheduling: boolean) {
  if (mode === "update") {
    return {
      title: rescheduling ? "Reschedule update" : "Schedule update",
      description: "The live post stays as it is until then.",
      action: rescheduling ? "Reschedule" : "Schedule update",
      note: SCHEDULED_UPDATE_NOTE,
    }
  }
  return {
    title: rescheduling ? "Reschedule" : "Schedule post",
    description: "It goes live at this time, with its content as it is then.",
    action: rescheduling ? "Reschedule" : "Schedule",
    note: null,
  }
}

// What a scheduled update publishes (#335): the content as it is when it's scheduled.
export const SCHEDULED_UPDATE_NOTE =
  "The update uses the post as it is now. Changes made after you schedule aren’t included; schedule again to include them."

function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const total = year * 12 + month + delta
  return { year: Math.floor(total / 12), month: total % 12 }
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

export default function ScheduleDialog({ isOpen, onClose, publishAt, settings, onSchedule, mode = "publish", now = () => new Date() }: ScheduleDialogProps) {
  const { language, timeZone } = settings
  const zoneKnown = settings.loaded !== false
  const ids = useId()
  const [date, setDate] = useState("")
  const [time, setTime] = useState("09:00")
  const [view, setView] = useState({ year: 2026, month: 0 })
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const timeRef = useRef<HTMLInputElement>(null)

  // Each opening starts from the current schedule, or tomorrow 09:00.
  useEffect(() => {
    if (!isOpen) return
    const start = defaultScheduleParts(publishAt, timeZone, now())
    setDate(start.date)
    setTime(start.time)
    const [y, m] = start.date.split("-").map(Number)
    setView({ year: y, month: m - 1 })
    setTouched(false)
    setServerError(null)
    // Again once the zone is known: the default day depends on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, timeZone])

  const today = zonedParts(now(), timeZone).date
  const local = joinLocal(date, time)
  const error = scheduleError(local, timeZone, now())
  const instant = zonedToUtc(local, timeZone)
  const rows = useMemo(() => monthGrid(view.year, view.month), [view])
  const weekdays = useMemo(() => weekdayLabels(language), [language])

  const pick = (next: string) => {
    setDate(next)
    setServerError(null)
    const [y, m] = next.split("-").map(Number)
    if (y !== view.year || m - 1 !== view.month) setView({ year: y, month: m - 1 })
  }

  // Arrow keys move the day, Page Up/Down the month (the grid's roving focus).
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
    let next: string | null = null
    if (e.key in moves) next = addDays(date, moves[e.key])
    else if (e.key === "PageUp" || e.key === "PageDown") {
      const [y, m, d] = date.split("-").map(Number)
      const target = addMonths(y, m - 1, e.key === "PageUp" ? -1 : 1)
      const last = new Date(Date.UTC(target.year, target.month + 1, 0)).getUTCDate()
      next = `${target.year}-${String(target.month + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`
    }
    if (!next || next < today) return
    e.preventDefault()
    pick(next)
    requestAnimationFrame(() => gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${next}"]`)?.focus())
  }

  const submit = async () => {
    setTouched(true)
    if (error || !zoneKnown) return
    setBusy(true)
    setServerError(null)
    try {
      await onSchedule(local)
      onClose()
    } catch (e) {
      setServerError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const shownError = serverError ?? (touched ? error : null)
  const rescheduling = !!publishAt
  const text = scheduleDialogText(mode, rescheduling)

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => !busy && onClose()}
      size="small"
      title={text.title}
      description={text.description}
      initialFocus={timeRef}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!zoneKnown}>
            {text.action}
          </Button>
        </>
      }
    >
      <div className="gl-schedule">
        <div className="gl-schedule__fields">
          <div className="gl-schedule__field">
            <label htmlFor={`${ids}-date`} className="gl-schedule__label">
              Date
            </label>
            <button
              id={`${ids}-date`}
              type="button"
              className="gl-schedule__control gl-schedule__date"
              onClick={() => gridRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus()}
            >
              <CalendarIcon />
              {date ? dateFieldLabel(date, language) : "Pick a date"}
            </button>
          </div>
          <div className="gl-schedule__field gl-schedule__field--time">
            <label htmlFor={`${ids}-time`} className="gl-schedule__label">
              Time
            </label>
            <input
              id={`${ids}-time`}
              ref={timeRef}
              type="text"
              inputMode="numeric"
              placeholder="HH:MM"
              maxLength={5}
              className="gl-schedule__control"
              value={time}
              aria-invalid={!!shownError || undefined}
              aria-describedby={shownError ? `${ids}-error` : `${ids}-zone`}
              onChange={(e) => {
                setTime(e.target.value)
                setServerError(null)
              }}
              onBlur={() => setTouched(true)}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
            />
          </div>
        </div>

        <div className="gl-schedule__calendar">
          <div className="gl-schedule__month">
            <button
              type="button"
              aria-label="Previous month"
              className="gl-schedule__nav"
              disabled={`${view.year}-${String(view.month + 1).padStart(2, "0")}` <= today.slice(0, 7)}
              onClick={() => setView(addMonths(view.year, view.month, -1))}
            >
              <ChevronLeftIcon size={14} />
            </button>
            <span className="gl-schedule__month-label" aria-live="polite">
              {monthLabel(view.year, view.month, language)}
            </span>
            <button type="button" aria-label="Next month" className="gl-schedule__nav" onClick={() => setView(addMonths(view.year, view.month, 1))}>
              <ChevronRightIcon size={14} />
            </button>
          </div>
          <div ref={gridRef} role="grid" aria-label={monthLabel(view.year, view.month, language)} className="gl-schedule__grid" onKeyDown={onGridKey}>
            <div role="row" className="gl-schedule__row">
              {weekdays.map((w) => (
                <span key={w} role="columnheader" className="gl-schedule__weekday">
                  {w}
                </span>
              ))}
            </div>
            {rows.map((row, i) => (
              <div role="row" key={i} className="gl-schedule__row">
                {row.map((cell, j) =>
                  cell ? (
                    <span role="gridcell" key={j}>
                      <button
                        type="button"
                        data-date={cell.date}
                        aria-pressed={cell.date === date}
                        aria-label={dateFieldLabel(cell.date, language)}
                        tabIndex={cell.date === date ? 0 : -1}
                        disabled={cell.date < today}
                        className={`gl-schedule__day${cell.date === date ? " is-selected" : ""}${cell.date === today ? " is-today" : ""}`}
                        onClick={() => pick(cell.date)}
                      >
                        {cell.day}
                      </button>
                    </span>
                  ) : (
                    <span role="gridcell" key={j} />
                  )
                )}
              </div>
            ))}
          </div>
        </div>

        <span id={`${ids}-zone`} className="gl-schedule__zone">
          {zoneKnown ? timeZoneLine(timeZone, instant ?? now()) : "Loading the site's time zone from Settings…"}
        </span>
        {text.note && (
          <p className="gl-schedule__note">
            <InfoIcon size={16} />
            <span>{text.note}</span>
          </p>
        )}
        {shownError && <FieldError id={`${ids}-error`}>{shownError}</FieldError>}
      </div>
    </Modal>
  )
}

import { getMentionPeople, type MentionPerson } from "./api/mentions"

// Members' current names for the editor's mentions (#320): a mention stores the member's
// id (and their name when it was inserted, `label`); the editor shows the name they have
// now. Memory only (rule 0: nothing about a post survives a reload on the device), shared
// by every open editor, filled by the @ menu's results and by batched lookups of the ids
// the editor shows (`GET /mentions/people?ids=`).

type Entry = { person: MentionPerson } | { missing: true }

const known = new Map<number, Entry>()
const listeners = new Set<() => void>()
let pending = new Set<number>()
let timer: ReturnType<typeof setTimeout> | null = null

/** Most ids one lookup asks for (the API's cap). */
export const MENTION_LOOKUP_MAX = 100

function notify() {
  listeners.forEach((listener) => listener())
}

/** The member's name now: full name, else username; undefined until known, null for a member removed since. */
export function mentionName(userId: number): string | null | undefined {
  const entry = known.get(userId)
  if (!entry) return undefined
  if ("missing" in entry) return null
  return entry.person.full_name.trim() || entry.person.username
}

/** Remember members the @ menu or another read returned. */
export function rememberMentionPeople(people: MentionPerson[]): void {
  let changed = false
  for (const person of people) {
    const before = known.get(person.id)
    if (before && "person" in before && before.person.full_name === person.full_name && before.person.username === person.username) continue
    known.set(person.id, { person })
    changed = true
  }
  if (changed) notify()
}

/** Ask for the names of `userId` (batched with the other ids asked for in the same tick). */
export function requestMentionName(userId: number): void {
  if (known.has(userId) || pending.has(userId)) return
  pending.add(userId)
  if (timer) return
  timer = setTimeout(flush, 0)
}

async function flush() {
  timer = null
  const ids = [...pending].slice(0, MENTION_LOOKUP_MAX)
  pending = new Set([...pending].slice(MENTION_LOOKUP_MAX))
  if (pending.size > 0) timer = setTimeout(flush, 0)
  try {
    const people = await getMentionPeople(ids)
    const found = new Set(people.map((p) => p.id))
    rememberMentionPeople(people)
    let changed = false
    for (const id of ids) {
      if (!found.has(id)) {
        known.set(id, { missing: true })
        changed = true
      }
    }
    if (changed) notify()
  } catch {
    // Not known yet: the stored label shows, and the next view asks again.
  }
}

/** Called whenever a name becomes known. Returns the unsubscribe. */
export function subscribeMentionNames(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Tests: forget everything. */
export function resetMentionNames(): void {
  known.clear()
  pending.clear()
  if (timer) clearTimeout(timer)
  timer = null
}

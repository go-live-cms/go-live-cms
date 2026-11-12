// The estimate both halves show: words at 200 a minute, at least one minute. Pure, so the
// public renderer gives the same answer on every render (PluginBlockBoundary renders a
// plugin block twice on the server). A words-per-minute setting waits for plugin settings
// (#457).
export const WORDS_PER_MINUTE = 200

export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word !== "").length
}

export function readingMinutes(words: number): number {
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE))
}

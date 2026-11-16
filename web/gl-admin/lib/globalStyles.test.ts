// @vitest-environment node
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { declaredTokens, type FontOption, type GlobalStylesTheme } from "@/lib/globalStyles"
import defaultConfig from "../../themes/default/theme.config"
import {
  buildStyleForm,
  changedGroupsLabel,
  contrastSummary,
  describeChange,
  draftFromOverrides,
  fieldErrors,
  fieldMessage,
  fieldText,
  fontChoices,
  formatRatio,
  groupChanged,
  humanize,
  overridesFromDraft,
  pairLabel,
  passCount,
  resetGroup,
  setOverride,
  STYLE_GROUPS,
} from "./globalStyles"

// The styles screen's rules (#487). The vectors are the ones the API's tests read
// (src/lib/globalStyleVectors.json, #485): whatever a field can hold, the form refuses
// what the API refuses, with the API's message.
interface Vectors {
  theme: { tokens: Record<string, unknown>; font_options: FontOption[] }
  system_fonts: string[]
  valid: { name: string; input: unknown; normalized: unknown }[]
  invalid: { name: string; input: unknown; code: string; path: string; message: string }[]
}
const vectors: Vectors = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../src/lib/globalStyleVectors.json"), "utf8")
)
const vectorTheme: GlobalStylesTheme = { tokens: vectors.theme.tokens, fontOptions: vectors.theme.font_options }
const vectorForm = buildStyleForm(vectors.theme.tokens, vectors.theme.font_options)

const defaultTokens = declaredTokens(defaultConfig)
const defaultTheme: GlobalStylesTheme = { tokens: defaultTokens, fontOptions: defaultConfig.fontOptions }
const form = buildStyleForm(defaultTokens, defaultConfig.fontOptions)

// [path, leaf] when an override is one value; null otherwise.
function singleLeaf(input: unknown): [string, unknown] | null {
  let current = input
  const keys: string[] = []
  while (typeof current === "object" && current !== null && !Array.isArray(current)) {
    const entries = Object.entries(current)
    if (entries.length !== 1) return null
    keys.push(entries[0][0])
    current = entries[0][1]
  }
  return keys.length ? [keys.join("."), current] : null
}

describe("the shared vectors", () => {
  // Every refusal a field can hold: a string in a colour, length or font field, or a
  // number typed into a line height.
  const typeable = vectors.invalid.flatMap((v) => {
    const leaf = singleLeaf(v.input)
    if (!leaf) return []
    const field = vectorForm.fields.get(leaf[0])
    if (!field) return []
    if (typeof leaf[1] === "string" && field.kind !== "lineHeight") return [{ v, path: leaf[0], text: leaf[1] }]
    if (typeof leaf[1] === "number" && field.kind === "lineHeight") return [{ v, path: leaf[0], text: String(leaf[1]) }]
    return []
  })

  it("cover the field kinds", () => {
    const kinds = new Set(typeable.map(({ path }) => vectorForm.fields.get(path)!.kind))
    expect([...kinds].sort()).toEqual(["color", "font", "length", "lineHeight"])
    expect(typeable.some(({ v }) => v.code === "token_order")).toBe(true)
    expect(typeable.length).toBeGreaterThan(40)
  })

  it.each(typeable.map((t) => [t.v.name, t] as const))(
    "refuses %s with the API's message",
    (_, { v, path: fieldPath, text }) => {
      const overrides = setOverride(vectorForm, {}, fieldPath, text)
      expect(fieldErrors(vectorForm, overrides, vectorTheme)).toEqual({ [v.path]: fieldMessage(v.message, v.path) })
    }
  )

  it.each(vectors.valid.map((v) => [v.name, v] as const))("accepts %s", (_, v) => {
    const { overrides, stale } = overridesFromDraft(vectorForm, v.input)
    if (stale.length > 0) return // a key the form has no field for: not something it can send
    expect(fieldErrors(vectorForm, overrides, vectorTheme)).toEqual({})
  })
})

describe("fields", () => {
  it("are the theme's declared tokens, light and dark side by side", () => {
    const primary = form.colors.find((row) => row.name === "primary")!
    expect(primary).toMatchObject({ label: "Primary", use: "Links, buttons, focus" })
    expect(primary.light).toMatchObject({ path: "colors.light.primary", label: "Primary (light)", kind: "color" })
    expect(primary.dark?.path).toBe("colors.dark.primary")
    expect(form.colors.slice(0, 4).map((row) => row.name)).toEqual([
      "primary",
      "primaryHover",
      "primarySubtle",
      "onPrimary",
    ])
    expect(form.colors).toHaveLength(Object.keys((defaultTokens.colors as { light: object }).light).length)
  })

  it("orders the scale, line heights, layout and spacing as people read them", () => {
    expect(form.fontSizes.map((f) => f.path.split(".").pop())).toEqual([
      "xs",
      "sm",
      "base",
      "lg",
      "xl",
      "2xl",
      "3xl",
      "4xl",
    ])
    expect(form.lineHeights.map((f) => f.label)).toEqual([
      "Tight line height",
      "Snug line height",
      "Normal line height",
      "Relaxed line height",
    ])
    expect(form.layout.map((f) => f.label)).toEqual([
      "Container",
      "Wide width",
      "Content width",
      "Gutter",
      "Header height",
    ])
    expect(form.spacing.map((f) => f.label)).toEqual([
      "space-1",
      "space-2",
      "space-3",
      "space-4",
      "space-5",
      "space-6",
      "space-7",
      "space-8",
      "space-9",
      "space-10",
    ])
    expect(form.radius.map((f) => f.label)).toEqual(["radius-sm", "radius-md", "radius-lg", "radius-full"])
  })

  it("shows fonts by the option that is the theme's stack", () => {
    expect(form.fonts.map((f) => [f.label, f.defaultText])).toEqual([
      ["Body", "literata"],
      ["Headings", "inter"],
      ["Code", "jetbrains-mono"],
    ])
    const choices = fontChoices(form, form.fonts[0], "Paper", ["system-sans", "system-serif", "system-mono"])
    expect(choices.map((c) => c.value)).toEqual([
      "literata",
      "inter",
      "jetbrains-mono",
      "system-sans",
      "system-serif",
      "system-mono",
    ])
    expect(choices[3]).toMatchObject({ label: "System sans", description: "On the reader's device, no download" })
  })

  it("offers the theme's own default when it isn't one of its options", () => {
    const odd = buildStyleForm({ typography: { fontFamily: { base: "Papyrus, fantasy" } } }, [])
    expect(odd.fonts[0].defaultText).toBe("")
    expect(fontChoices(odd, odd.fonts[0], "Odd", ["system-sans"])[0]).toEqual({ value: "", label: "Odd's default" })
  })

  it("names block colours as text and fill", () => {
    const red = form.blockColors.find((t) => t.token === "red")!
    expect(red.rows.map((r) => r.label)).toEqual(["Red text", "Red fill"])
    expect(red.rows[1].dark?.path).toBe("blockColors.dark.red.background")
  })

  it("humanizes names the theme gives", () => {
    expect(humanize("surface2")).toBe("Surface 2")
    expect(humanize("infoBg")).toBe("Info background")
    expect(humanize("wideWidth")).toBe("Wide width")
  })
})

describe("the form's state", () => {
  it("holds only what differs from the theme", () => {
    let overrides = setOverride(form, {}, "colors.light.primary", "#155E4B")
    expect(overrides).toEqual({ "colors.light.primary": "#155E4B" })
    const theme = form.fields.get("colors.light.primary")!.defaultText
    overrides = setOverride(form, overrides, "colors.light.primary", theme.toUpperCase())
    expect(overrides).toEqual({})
    expect(setOverride(form, {}, "typography.lineHeight.normal", "1.50")).toEqual({})
    expect(setOverride(form, {}, "layout.container", " 1200px")).toEqual({ "layout.container": " 1200px" })
    expect(setOverride(form, {}, "colors.light.nope", "#000000")).toEqual({})
  })

  it("shows the override, else the theme's value", () => {
    const field = form.fields.get("layout.contentWidth")!
    expect(fieldText(field, {})).toBe("680px")
    expect(fieldText(field, { "layout.contentWidth": "720px" })).toBe("720px")
  })

  it("saves the draft nested as ThemeConfig, line heights as numbers", () => {
    const draft = draftFromOverrides(form, {
      "colors.light.primary": "#155e4b",
      "colors.dark.primary": "#3fe0b3",
      "typography.fontFamily.heading": "literata",
      "typography.lineHeight.normal": "1.6",
      "layout.contentWidth": "720px",
    })
    expect(draft).toEqual({
      colors: { light: { primary: "#155e4b" }, dark: { primary: "#3fe0b3" } },
      layout: { contentWidth: "720px" },
      typography: { fontFamily: { heading: "literata" }, lineHeight: { normal: 1.6 } },
    })
    expect(validateRoundTrip(draft)).toEqual(draft)
  })

  it("reads a stored draft back, and names what the theme no longer declares", () => {
    const { overrides, stale } = overridesFromDraft(form, {
      colors: { light: { primary: "#155e4b", retired: "#ffe7b3" } },
      typography: { lineHeight: { normal: 1.6 } },
    })
    expect(overrides).toEqual({ "colors.light.primary": "#155e4b", "typography.lineHeight.normal": "1.6" })
    expect(stale).toEqual(["colors.light.retired"])
    // The next save leaves the stale key out: the API would refuse it (unknown_token).
    expect(draftFromOverrides(form, overrides)).toEqual({
      colors: { light: { primary: "#155e4b" } },
      typography: { lineHeight: { normal: 1.6 } },
    })
  })

  it("resets one group, and says which groups changed", () => {
    const overrides = {
      "colors.light.primary": "#155e4b",
      "blockColors.light.red.text": "#aa0000",
      "typography.fontFamily.base": "inter",
      "typography.fontSize.xl": "1.5rem",
      "typography.lineHeight.normal": "1.6",
      "spacing.1": "2px",
      "radius.sm": "2px",
    }
    expect(STYLE_GROUPS.filter((g) => groupChanged(overrides, g.id)).map((g) => g.id)).toEqual([
      "colors",
      "blockColors",
      "fonts",
      "typeScale",
      "spacingRadius",
    ])
    expect(resetGroup(overrides, "typeScale")).toEqual({
      "colors.light.primary": "#155e4b",
      "blockColors.light.red.text": "#aa0000",
      "typography.fontFamily.base": "inter",
      "spacing.1": "2px",
      "radius.sm": "2px",
    })
    expect(Object.keys(resetGroup(overrides, "spacingRadius"))).not.toContain("radius.sm")
    // Colours never reach into block colours.
    expect(resetGroup(overrides, "colors")).toHaveProperty(["blockColors.light.red.text"])
  })
})

describe("errors", () => {
  it("names every wrong field at once", () => {
    const errors = fieldErrors(form, { "colors.light.primary": "red", "radius.md": "calc(1px + 2px)" }, defaultTheme)
    expect(errors).toEqual({
      "colors.light.primary": "Must be a colour like #1b7760.",
      "radius.md": "Must be a length (px, rem, em, %, vw) or clamp() of lengths.",
    })
  })

  it("checks the order rules once every value is right", () => {
    expect(fieldErrors(form, { "layout.contentWidth": "1000px" }, defaultTheme)).toEqual({
      "layout.contentWidth": "contentWidth must be at most wideWidth.",
    })
    expect(fieldErrors(form, { "layout.contentWidth": "1000px", "layout.wideWidth": "1100px" }, defaultTheme)).toEqual(
      {}
    )
    expect(fieldErrors(form, { "spacing.2": "20px" }, defaultTheme)).toEqual({
      "spacing.2": "spacing 2 must be at most spacing 3.",
    })
  })

  it("describes the change a 409 lost", () => {
    expect(describeChange(form, { kind: "field", path: "colors.light.primary", text: "#155e4b" })).toBe(
      "Primary (light) to #155e4b"
    )
    expect(describeChange(form, { kind: "field", path: "typography.fontFamily.base", text: "system-serif" })).toBe(
      "Body to System serif"
    )
    expect(describeChange(form, { kind: "field", path: "typography.fontFamily.base", text: "inter" })).toBe(
      "Body to Inter"
    )
    expect(describeChange(form, { kind: "reset", group: "spacingRadius" })).toBe("Reset spacing & radius")
    expect(describeChange(form, { kind: "reset", group: "all" })).toBe("Reset all")
  })
})

describe("contrast", () => {
  it("passes the default theme, with the main pairs listed", () => {
    const summary = contrastSummary(defaultTheme, {})
    expect(summary.failing).toBe(0)
    expect(summary.rows.map((r) => r.label)).toEqual([
      "Text on background",
      "Text muted on surface",
      "Primary on background",
      "Primary on surface",
      "On primary on primary",
    ])
    expect(summary.rows.every((r) => r.light?.pass && r.dark?.pass)).toBe(true)
    expect(passCount(summary.others.light)).toMatch(/^All \d+ pass$/)
    // Nine block colours, each as text on three surfaces and as a fill under the text.
    expect(summary.blocks.light.total).toBe(36)
  })

  it("lists a failing pair, flags its colours and counts it", () => {
    const summary = contrastSummary(defaultTheme, { colors: { dark: { primary: "#1b3a30" } } })
    expect(summary.failing).toBeGreaterThan(0)
    const row = summary.rows.find((r) => r.id === "primary/surface")!
    expect(row.dark?.pass).toBe(false)
    expect(row.light?.pass).toBe(true)
    expect(summary.flagged.has("dark:primary")).toBe(true)
    expect(summary.flagged.has("light:primary")).toBe(false)
  })

  it("lists a failing block colour as its own row", () => {
    const summary = contrastSummary(defaultTheme, { blockColors: { light: { red: { text: "#ffeeee" } } } })
    const red = summary.rows.find((r) => r.label === "Red text on background")!
    expect(red.light?.pass).toBe(false)
    // The palette where it passes shows its ratio too, not a gap.
    expect(red.dark?.pass).toBe(true)
    expect(summary.flagged.has("light:blockColors.red.text")).toBe(true)
    expect(passCount(summary.blocks.light)).toBe("33 of 36 pass")
  })

  it("ignores an override that isn't a colour (the field shows that error instead)", () => {
    expect(contrastSummary(defaultTheme, { colors: { light: { text: "nope" } } }).failing).toBe(0)
  })

  it("formats ratios without rounding a failure up to its minimum", () => {
    expect(formatRatio(16.04)).toBe("16.0:1")
    expect(formatRatio(4.12)).toBe("4.1:1")
    expect(formatRatio(4.49)).toBe("4.4:1")
    expect(formatRatio(4.5)).toBe("4.5:1")
    expect(pairLabel("blockColors.red.text", "surface")).toBe("Red text on surface")
    expect(pairLabel("text", "blockColors.red.background")).toBe("Text on red fill")
  })

  it("names the groups a publish changes", () => {
    expect(changedGroupsLabel(["colors", "fonts", "spacing"])).toBe("Colours, Fonts, Spacing")
  })
})

function validateRoundTrip(draft: Record<string, unknown>) {
  const { overrides } = overridesFromDraft(form, draft)
  return draftFromOverrides(form, overrides)
}

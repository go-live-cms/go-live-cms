import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { ApiError } from "@gl-admin/lib/api/errors"
import {
  TEMPLATE_NAME_MAX,
  TEMPLATE_NAME_MIN,
  TEMPLATE_NAME_TAKEN,
  templateNameConflict,
  templateNameError,
  templateSummary,
} from "./postTemplates"

// Post templates' rules (#322). The name limits and the conflict code are the API's
// (api/post_templates.go, next to web/ in the repo; skipped where only web/ is mounted).
const API_FILE = path.resolve(__dirname, "../../../api/post_templates.go")

describe("template names", () => {
  it.skipIf(!existsSync(API_FILE))("match the API's limits and conflict code", () => {
    const go = readFileSync(API_FILE, "utf8")
    expect(Number(go.match(/postTemplateNameMin = (\d+)/)?.[1])).toBe(TEMPLATE_NAME_MIN)
    expect(Number(go.match(/postTemplateNameMax = (\d+)/)?.[1])).toBe(TEMPLATE_NAME_MAX)
    expect(go).toContain(`codeTemplateNameTaken = "${TEMPLATE_NAME_TAKEN}"`)
    // The bindings' max agrees too.
    expect(go).toContain(`binding:"required,max=${TEMPLATE_NAME_MAX},single_line"`)
  })

  it("refuses what the API refuses, counted in characters after trimming", () => {
    expect(templateNameError("")).toBe("Give the template a name.")
    expect(templateNameError("   ")).toBe("Give the template a name.")
    expect(templateNameError(" ab ")).toBe("Use at least 3 characters.")
    expect(templateNameError("two\nlines")).toBe("Keep the name on one line.")
    expect(templateNameError("x".repeat(121))).toBe("Use at most 120 characters.")
    expect(templateNameError("x".repeat(120))).toBeNull()
    expect(templateNameError("Até")).toBeNull()
    // An emoji is one character to the API (runes), two UTF-16 units here.
    expect(templateNameError("🙂".repeat(120))).toBeNull()
  })

  it("names the conflict only for the API's code", () => {
    expect(templateNameConflict(new ApiError("taken", 409, null, TEMPLATE_NAME_TAKEN), " Weekly ", "page")).toBe(
      "There's already a page template named “Weekly”."
    )
    expect(templateNameConflict(new ApiError("slug", 409, null, null), "Weekly")).toBeNull()
    expect(templateNameConflict(new Error("x"), "Weekly")).toBeNull()
  })
})

describe("templateSummary", () => {
  it("says which settings come along", () => {
    expect(templateSummary({ terms: [], featured_image_id: null })).toBe("Content only")
    expect(templateSummary({ terms: [{ id: 1, name: "News" }], featured_image_id: null })).toBe("Content · Category: News")
    expect(templateSummary({ terms: [{ id: 1, name: "News" }, { id: 2, name: "Guides" }], featured_image_id: 4 })).toBe(
      "Content · Categories: News, Guides · Featured image"
    )
    expect(templateSummary({ terms: [], featured_image_id: 4 })).toBe("Content · Featured image")
  })
})

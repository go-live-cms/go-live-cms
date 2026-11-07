import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import BlockRenderer from "../../BlockRenderer"
import { renderContent } from "./contentRenderer"
import { formatDateChip, labelDateChips } from "../../../lib/dateChips"

// #320 on the public site: the inline nodes as the public API sends them
// (api/inline_nodes.go `publicizeInlineNodes`): a mention is a plain name, a content link
// a link to its current URL (text alone without one), a date chip a formatted <time>.

const html = (content: unknown[]) => renderToStaticMarkup(<>{renderContent(content as any)}</>)

describe("the public renderer", () => {
  it("renders a mention as the member's name only", () => {
    expect(html([{ type: "text", text: "Ask " }, { type: "mention", attrs: { label: "Ana Costa" } }])).toBe('Ask <span class="gl-mention">Ana Costa</span>')
    // Even a working-copy node (the admin's History preview) shows only the name.
    const working = html([{ type: "mention", attrs: { userId: 7, label: "Ana Costa" } }])
    expect(working).toBe('<span class="gl-mention">Ana Costa</span>')
    expect(working).not.toContain("7")
    // No name, nothing.
    expect(html([{ type: "mention", attrs: { userId: 7 } }])).toBe("")
  })

  it("renders a content link as a link to its current URL, or its text without one", () => {
    expect(html([{ type: "contentLink", attrs: { label: "The guide", href: "/post/the-guide" } }])).toBe('<a class="gl-content-link" href="/post/the-guide">The guide</a>')
    expect(html([{ type: "contentLink", attrs: { label: "Coming soon" } }])).toBe("Coming soon")
    // Only a path on this site is ever a link.
    for (const href of ["javascript:alert(1)", "https://evil.example/x", "//evil.example/x", "post/x"]) {
      expect(html([{ type: "contentLink", attrs: { label: "x", href } }]), href).toBe("x")
    }
  })

  it("renders a date chip as a <time>, with the site's format when labelled", () => {
    expect(html([{ type: "dateChip", attrs: { date: "2026-11-12", time: null } }])).toBe('<time class="gl-date" dateTime="2026-11-12">November 12, 2026</time>')
    expect(html([{ type: "dateChip", attrs: { date: "2026-11-12", time: "14:30", label: "12 de novembro de 2026, 14:30" } }])).toBe(
      '<time class="gl-date" dateTime="2026-11-12T14:30">12 de novembro de 2026, 14:30</time>',
    )
    expect(html([{ type: "dateChip", attrs: { date: "not a day" } }])).toBe("")
  })

  it("applies marks to an inline node", () => {
    expect(html([{ type: "mention", attrs: { label: "Ana" }, marks: [{ type: "italic" }] }])).toBe('<em><span class="gl-mention">Ana</span></em>')
  })

  it("renders them inside a paragraph block through BlockRenderer", () => {
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: ["blk-inline-p0001"],
      blocks: {
        "blk-inline-p0001": {
          id: "blk-inline-p0001",
          type: "paragraph",
          version: 1,
          attrs: { pm: { type: "paragraph", content: [{ type: "text", text: "By " }, { type: "dateChip", attrs: { date: "2026-12-01", time: null } }] } },
        },
      },
    } as BlockDocV1
    const settings = { language: "pt-BR" as const, timeZone: "America/Sao_Paulo", dateFormat: "day_month_year" as const }
    const out = renderToStaticMarkup(<BlockRenderer doc={labelDateChips(structuredClone(doc), settings)} />)
    expect(out).toContain(`<time class="gl-date" dateTime="2026-12-01">${formatDateChip({ date: "2026-12-01", time: null, reminder: false }, settings, "long")}</time>`)
    expect(out).toContain("1 de dezembro de 2026")
  })
})

describe("formatDateChip", () => {
  it("is the calendar day in any site zone (never shifted)", () => {
    const chip = { date: "2026-01-01", time: null, reminder: false }
    for (const timeZone of ["Pacific/Kiritimati", "Pacific/Pago_Pago", "UTC"]) {
      expect(formatDateChip(chip, { language: "en-US", timeZone, dateFormat: "iso" })).toBe("2026-01-01")
    }
    expect(formatDateChip({ ...chip, time: "09:05" }, { language: "en-US", timeZone: "UTC", dateFormat: "month_day_year" })).toBe("Jan 1, 2026, 9:05 AM")
  })
})

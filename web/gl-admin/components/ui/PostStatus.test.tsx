import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import PostStatus, { PostStatusPill } from "./PostStatus"

// The status pill (#338), and "Changes not published" for a published post whose working
// copy differs from the live one (#326).

const pill = (markup: string) => {
  const el = document.createElement("div")
  el.innerHTML = markup
  return el.querySelector(".gl-pill")
}

describe("PostStatus", () => {
  it("names the status, with its tone", () => {
    const published = pill(renderToStaticMarkup(<PostStatusPill status="published" />))
    expect(published?.textContent).toBe("Published")
    expect(published?.classList.contains("gl-pill--success")).toBe(true)
    expect(pill(renderToStaticMarkup(<PostStatusPill status="draft" />))?.textContent).toBe("Draft")
  })

  it("says Changes not published for a published post with unpublished changes", () => {
    const changed = pill(renderToStaticMarkup(<PostStatusPill status="published" unpublishedChanges />))
    expect(changed?.textContent).toBe("Changes not published")
    expect(changed?.classList.contains("gl-pill--accent")).toBe(true)
    expect(pill(renderToStaticMarkup(<PostStatus status="published" iconPath="published" unpublishedChanges />))?.textContent).toBe(
      "Changes not published"
    )
  })

  it("ignores the flag on any other status", () => {
    expect(pill(renderToStaticMarkup(<PostStatusPill status="draft" unpublishedChanges />))?.textContent).toBe("Draft")
    expect(pill(renderToStaticMarkup(<PostStatusPill status="archived" unpublishedChanges />))?.textContent).toBe("Archived")
  })

  it("is a skeleton while the row loads", () => {
    const markup = renderToStaticMarkup(<PostStatus status={null} iconPath={null} unpublishedChanges />)
    expect(markup).toContain("gl-skeleton")
    expect(markup).not.toContain("Changes not published")
  })
})

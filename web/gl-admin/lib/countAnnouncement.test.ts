import { describe, expect, it } from "vitest"
import { countAnnouncement, countZone, nearThreshold } from "./countAnnouncement"

// A character counter speaks only near or over its limit (#477).

describe("countAnnouncement", () => {
  it("is near in the last 10% of the limit, never fewer than 10 characters", () => {
    expect(nearThreshold(60)).toBe(10)
    expect(nearThreshold(160)).toBe(16)
    expect(nearThreshold(500)).toBe(50)
    expect(countZone(49, 60)).toBe("under")
    expect(countZone(50, 60)).toBe("near")
    expect(countZone(60, 60)).toBe("near")
    expect(countZone(61, 60)).toBe("over")
  })

  it("says nothing far from the limit", () => {
    expect(countAnnouncement(0, 160)).toBeNull()
    expect(countAnnouncement(143, 160)).toBeNull()
  })

  it("counts down near it, and up past it", () => {
    expect(countAnnouncement(150, 160)).toBe("10 characters left.")
    expect(countAnnouncement(159, 160)).toBe("1 character left.")
    expect(countAnnouncement(160, 160)).toBe("At the limit of 160 characters.")
    expect(countAnnouncement(161, 160)).toBe("1 character over the limit of 160.")
    expect(countAnnouncement(72, 60, "Search results may cut it off.")).toBe(
      "12 characters over the limit of 60. Search results may cut it off."
    )
  })
})

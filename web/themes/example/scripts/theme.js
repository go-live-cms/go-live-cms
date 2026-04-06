/**
 * Example Theme Scripts
 * Demonstrates Phase 1 asset registration (scripts)
 */

console.log("Example Theme loaded - Phase 2 active!")

// Example: Add smooth scroll to anchor links
document.addEventListener("DOMContentLoaded", () => {
  const anchorLinks = document.querySelectorAll('a[href^="#"]')

  anchorLinks.forEach((link) => {
    link.addEventListener("click", (e) => {
      const href = link.getAttribute("href")
      if (href === "#") return

      e.preventDefault()
      const target = document.querySelector(href)
      if (target) {
        target.scrollIntoView({ behavior: "smooth" })
      }
    })
  })

  // Example: Log theme version
  const version = document.body.dataset.themeVersion || "unknown"
  console.log(`Running theme version: ${version}`)
})

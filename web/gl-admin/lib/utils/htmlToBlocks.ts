import type { BlockDocV1, Block } from "../blocks-spec"

export function htmlToBlockDoc(html: string): BlockDocV1 {
  if (typeof window === "undefined") {
    // Server-side fallback: return empty doc
    return {
      doc_version: 1,
      blocks_order: [],
      blocks: {},
    }
  }

  const parser = new DOMParser()
  const doc = parser.parseFromString(html, "text/html")

  const blocks: Record<string, Block> = {}
  const blocksOrder: string[] = []

  let counter = 0
  const generateId = () => `backfill-${Date.now()}-${counter++}`

  const processNode = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim()
      if (text) {
        const id = generateId()
        blocks[id] = {
          id,
          type: "paragraph",
          version: 1,
          attrs: { text },
        }
        blocksOrder.push(id)
      }
      return
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return

    const element = node as HTMLElement
    const id = generateId()

    switch (element.tagName.toLowerCase()) {
      case "p":
        blocks[id] = {
          id,
          type: "paragraph",
          version: 1,
          attrs: { text: element.textContent || "" },
        }
        blocksOrder.push(id)
        break

      case "h1":
      case "h2":
      case "h3": {
        const level = parseInt(element.tagName[1]) as 1 | 2 | 3
        blocks[id] = {
          id,
          type: "heading",
          version: 1,
          attrs: {
            level,
            text: element.textContent || "",
          },
        }
        blocksOrder.push(id)
        break
      }

      case "blockquote":
        blocks[id] = {
          id,
          type: "blockquote",
          version: 1,
          attrs: { text: element.textContent || "" },
        }
        blocksOrder.push(id)
        break

      case "pre": {
        const code = element.querySelector("code")
        const langMatch = code?.className.match(/language-(\w+)/)
        blocks[id] = {
          id,
          type: "code_block",
          version: 1,
          attrs: {
            language: langMatch?.[1] || "text",
            code: code?.textContent || element.textContent || "",
          },
        }
        blocksOrder.push(id)
        break
      }

      case "hr":
        blocks[id] = {
          id,
          type: "divider",
          version: 1,
          attrs: {},
        }
        blocksOrder.push(id)
        break

      case "img":
        blocks[id] = {
          id,
          type: "image",
          version: 1,
          attrs: {
            src: element.getAttribute("src") || undefined,
            alt: element.getAttribute("alt") || undefined,
            title: element.getAttribute("title") || undefined,
          },
        }
        blocksOrder.push(id)
        break

      case "ul": {
        const ulId = id
        const ulChildren: string[] = []
        element.querySelectorAll(":scope > li").forEach((li) => {
          const liId = generateId()
          blocks[liId] = {
            id: liId,
            type: "list_item",
            version: 1,
            attrs: { text: li.textContent || "" },
          }
          ulChildren.push(liId)
        })
        blocks[ulId] = {
          id: ulId,
          type: "bullet_list",
          version: 1,
          attrs: {},
          children: ulChildren,
        }
        blocksOrder.push(ulId)
        break
      }

      case "ol": {
        const olId = id
        const olChildren: string[] = []
        element.querySelectorAll(":scope > li").forEach((li) => {
          const liId = generateId()
          blocks[liId] = {
            id: liId,
            type: "list_item",
            version: 1,
            attrs: { text: li.textContent || "" },
          }
          olChildren.push(liId)
        })
        blocks[olId] = {
          id: olId,
          type: "ordered_list",
          version: 1,
          attrs: {},
          children: olChildren,
        }
        blocksOrder.push(olId)
        break
      }

      default:
        // Check for custom block elements (e.g., <div data-block-type="alert">)
        const blockType = element.getAttribute("data-block-type")
        if (blockType) {
          // Collect all data-* attributes as block attrs
          const customAttrs: Record<string, unknown> = {
            text: element.textContent || undefined,
          }
          for (const attr of Array.from(element.attributes)) {
            if (attr.name.startsWith("data-") && attr.name !== "data-block-type" && attr.name !== "data-block-id") {
              // Convert data-variant → variant
              const key = attr.name.replace(/^data-/, "")
              customAttrs[key] = attr.value
            }
          }
          blocks[id] = {
            id,
            type: blockType,
            version: 1,
            attrs: customAttrs,
          }
          blocksOrder.push(id)
        } else {
          // Recursively process children for unknown elements
          element.childNodes.forEach((child) => processNode(child))
        }
    }
  }

  doc.body.childNodes.forEach((node) => processNode(node))

  return {
    doc_version: 1,
    blocks_order: blocksOrder,
    blocks,
  }
}

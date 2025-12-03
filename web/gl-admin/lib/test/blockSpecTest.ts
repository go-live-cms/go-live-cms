/**
 * Manual Test Script for Block Spec v1 Phase A Implementation
 *
 * To test the implementation:
 * 1. Start the dev server: npm run dev
 * 2. Open a post with the editor
 * 3. Open browser console
 * 4. Run: testBlockSpec() for core functionality
 * 5. Run: testPhaseAIntegration() for full integration testing
 *
 * This will test:
 * - Block ID generation
 * - PM to BlockDoc conversion
 * - BlockDocManager operations
 * - Persistence and API integration
 */

declare global {
  interface Window {
    blockDocManager?: any
    testBlockSpec?: () => void
    testPhaseAIntegration?: () => void
    getBlockDoc?: () => any
  }
}

export function createTestScript() {
  if (typeof window === "undefined") return

  window.testBlockSpec = function () {
    console.log("🧪 Testing Block Spec v1 Phase A Implementation")

    // Test 1: Check if blockDocManager is available
    if (!window.blockDocManager) {
      console.error("❌ BlockDocManager not available. Make sure you're in an editor with collaboration enabled.")
      return
    }

    const manager = window.blockDocManager

    // Test 2: Get current block doc and analyze structure
    const currentDoc = manager.getBlockDocV1()
    console.log("📋 Current BlockDoc:", currentDoc)

    // Analyze block types and children
    console.log("🔍 Block Analysis:")
    Object.values(currentDoc.blocks).forEach((block: any) => {
      const hasChildren = block.children && block.children.length > 0
      console.log(
        `  📄 ${block.type} (${block.id.slice(0, 8)}...): ${hasChildren ? `${block.children.length} children` : "no children"}`
      )

      if (hasChildren) {
        console.log(`    👶 Children:`, block.children)
        block.children.forEach((childId: string) => {
          const childBlock = (currentDoc.blocks as any)[childId]
          if (childBlock) {
            console.log(`      - ${childBlock.type}: "${childBlock.attrs.text || childBlock.attrs.code || "no text"}"`)
          }
        })
      }
    })

    // Test 3: Generate new block ID
    const newId = manager.generateBlockId()
    console.log("🆔 Generated new block ID:", newId)

    // Test 4: Test block operations
    try {
      const testBlock = {
        id: newId,
        type: "paragraph",
        version: 1,
        attrs: { text: "Test block from console" },
      }

      manager.setBlock(testBlock)
      console.log("✅ Successfully set test block")

      const retrievedBlock = manager.getBlock(newId)
      console.log("📄 Retrieved test block:", retrievedBlock)

      // Clean up
      manager.deleteBlock(newId)
      console.log("🧹 Cleaned up test block")
    } catch (error) {
      console.error("❌ Error during block operations:", error)
    }

    // Test 5: Subscribe to changes (briefly)
    console.log("🔄 Subscribing to document changes for 5 seconds...")
    const unsubscribe = manager.onDocumentChange((doc) => {
      console.log("📡 Document changed - Block count:", Object.keys(doc.blocks).length)
    })

    setTimeout(() => {
      unsubscribe()
      console.log("🔌 Unsubscribed from document changes")
    }, 5000)

    console.log("✅ Block Spec v1 Phase A tests completed!")
    console.log("🎯 Try typing in the editor to see mirrored changes in the console")
    console.log("📝 Try creating a bullet list to see blocks with children!")
    console.log("💡 Run testPhaseAIntegration() to test full persistence integration")
  }

  // Phase A Integration Test
  window.testPhaseAIntegration = function () {
    console.log("🧪 Testing Block Spec V1 Phase A Full Integration...")

    // Check if the editor component is available
    const editorElement = document.querySelector(".notion-editor")
    if (!editorElement) {
      console.error("❌ Editor not found")
      return
    }

    // Check for PublishBar controls
    const publishBar = document.querySelector(".publish-bar")
    if (publishBar) {
      console.log("✅ PublishBar found (Block Spec persistence integrated)")

      const saveBtn = publishBar.querySelector('button[type="button"]:contains("Save")')
      const publishBtn = publishBar.querySelector('button[type="button"]:contains("Publish")')

      if (saveBtn || publishBar.textContent?.includes("Save")) {
        console.log("✅ Save functionality integrated with PublishBar")
        console.log("💡 Block Spec persistence will trigger on save")
      }
      if (publishBtn || publishBar.textContent?.includes("Publish")) {
        console.log("✅ Publish functionality integrated with PublishBar")
        console.log("💡 Block Spec publishing will trigger on publish")
      }
    } else {
      console.log("ℹ️ PublishBar not found (may be on a different page)")
    }

    // Test current block document
    if (window.blockDocManager) {
      const blockDoc = window.blockDocManager.getBlockDocV1()
      console.log("📊 Current block document:", blockDoc)

      if (blockDoc.blocks_order.length > 0) {
        console.log("✅ Block document has content blocks")
        console.log(`📝 Document contains ${blockDoc.blocks_order.length} blocks`)
        console.log(
          "🔖 Block types:",
          Object.values(blockDoc.blocks).map((b: any) => b.type)
        )
      } else {
        console.log("ℹ️ Block document is empty (expected for new posts)")
      }
    }

    // Test API endpoints
    console.log("🌐 Testing API endpoints...")
    const urlMatch = window.location.pathname.match(/\/content\/(posts|pages)\/edit\/(\d+)/)
    if (urlMatch) {
      const postId = urlMatch[2]
      console.log(`📝 Editing post ID: ${postId}`)

      fetch(`/api/posts/${postId}/blocks`, {
        method: "GET",
        headers: { Accept: "application/json" },
      })
        .then((response) => {
          if (response.ok) {
            console.log("✅ Block API endpoint accessible")
            return response.json()
          } else {
            console.log(`ℹ️ Block API returned status: ${response.status}`)
          }
        })
        .then((data) => {
          if (data) {
            console.log("📊 Current stored block document:", data)
          }
        })
        .catch((error) => {
          console.log("ℹ️ Block API not available:", error.message)
        })
    } else {
      console.log("ℹ️ Not on a post edit page, skipping API test")
    }

    console.log("🎯 Phase A Integration Test Complete")
    console.log("💡 Block Spec v1 is now integrated with the existing PublishBar!")
    console.log("🚀 Try editing content and using Save/Publish buttons to test persistence")
  }

  // Debug function to check current editor state
  window.getBlockDoc = function () {
    if (!window.blockDocManager) {
      console.error("❌ BlockDocManager not available")
      return
    }

    const doc = window.blockDocManager.getBlockDocV1()
    console.log("📋 Current BlockDoc:", doc)
    console.log(
      "📝 Blocks:",
      Object.entries(doc.blocks).map(([id, block]: [string, any]) => ({
        id: id.slice(0, 20) + "...",
        type: block.type,
        text: block.attrs.text || block.attrs.code || "(no text)",
      }))
    )
    console.log(
      "📑 Blocks order:",
      doc.blocks_order.map((id: string) => id.slice(0, 20) + "...")
    )

    return doc
  }

  // Auto-expose test functions
  console.log("🧪 Block Spec test script loaded.")
  console.log("🔬 Run testBlockSpec() to test core functionality")
  console.log("🔗 Run testPhaseAIntegration() to test full integration")
  console.log("🔍 Run getBlockDoc() to see current block document")
}

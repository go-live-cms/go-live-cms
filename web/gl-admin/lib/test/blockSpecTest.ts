/**
 * Manual Test Script for Block Spec v1 Phase A Implementation
 *
 * To test the implementation:
 * 1. Start the dev server: npm run dev
 * 2. Open a post with the editor
 * 3. Open browser console
 * 4. Run: testBlockSpec()
 *
 * This will test:
 * - Block ID generation
 * - PM to BlockDoc conversion
 * - BlockDocManager operations
 */

declare global {
  interface Window {
    blockDocManager?: any
    testBlockSpec?: () => void
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
  }

  // Auto-expose test function
  console.log("🧪 Block Spec test script loaded. Run testBlockSpec() to test.")
}

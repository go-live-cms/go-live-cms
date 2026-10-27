package api

import "fmt"

// Structural limits for a Block Spec v1 document written to block_doc (#139):
// the collab server's store and POST /posts. The body size is capped separately (blockDocBodyLimit). These stop
// documents that fit that cap but are expensive to store, sanitize and
// render: a huge number of tiny blocks, or nesting deep enough to blow the
// public renderer's recursion.
const (
	maxBlockDocBlocks = 5000
	// maxBlockDocDepth is JSON nesting (objects and arrays) inside one block.
	// A ProseMirror level is two (node object + content array), so this
	// allows lists nested far deeper than any editor produces.
	maxBlockDocDepth = 100
	maxBlockIDLength = 128
)

// checkLimits returns an error describing the first limit doc exceeds.
func (doc *BlockDocV1) checkLimits() error {
	if len(doc.Blocks) > maxBlockDocBlocks {
		return fmt.Errorf("document has %d blocks, the maximum is %d", len(doc.Blocks), maxBlockDocBlocks)
	}
	if len(doc.BlocksOrder) > maxBlockDocBlocks {
		return fmt.Errorf("blocks_order has %d entries, the maximum is %d", len(doc.BlocksOrder), maxBlockDocBlocks)
	}
	for id, block := range doc.Blocks {
		if len(id) == 0 || len(id) > maxBlockIDLength {
			return fmt.Errorf("block ids must be 1-%d bytes", maxBlockIDLength)
		}
		if jsonDepthExceeds(block, maxBlockDocDepth) {
			return fmt.Errorf("block %q is nested deeper than %d levels", truncateID(id), maxBlockDocDepth)
		}
	}
	return nil
}

// jsonDepthExceeds reports whether a decoded JSON value nests objects and
// arrays more than limit levels deep. It stops as soon as it knows.
func jsonDepthExceeds(v interface{}, limit int) bool {
	switch t := v.(type) {
	case map[string]interface{}:
		if limit <= 0 {
			return true
		}
		for _, child := range t {
			if jsonDepthExceeds(child, limit-1) {
				return true
			}
		}
	case []interface{}:
		if limit <= 0 {
			return true
		}
		for _, child := range t {
			if jsonDepthExceeds(child, limit-1) {
				return true
			}
		}
	}
	return false
}

func truncateID(id string) string {
	if len(id) > 32 {
		return id[:32] + "..."
	}
	return id
}

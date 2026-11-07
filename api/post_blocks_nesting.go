package api

import (
	"fmt"
	"sort"
)

// How blocks nest in Block Spec v1 (#414, docs/design/block-library.md 2.2–2.3). The
// table is the web's `blocks-spec/nesting.ts`; both sides read
// `web/gl-admin/lib/blocks-spec/nestingVectors.json` in their tests
// (post_blocks_nesting_test.go), so the collab server's store and this API agree on every
// doc. A container holds its child blocks by id in `children`, each a full block in the
// flat `blocks` map, as lists hold their items.

// blockContainer is a container's row in the nesting table.
type blockContainer struct {
	// What it holds: "flow" (every flow type) and/or container types.
	accepts []string
	min     int
	// max 0 = no limit.
	max int
}

// blockContainers: the containers. Group (#414) is the first; columns, details, … are
// rows here and in nesting.ts.
var blockContainers = map[string]blockContainer{
	"group": {accepts: []string{"flow"}, min: 1},
}

// flowBlockTypes are the core types that hold no blocks. Lists count as flow (their
// items are their own business); so does the table (#420: its rows are in its pm).
var flowBlockTypes = map[string]bool{
	"paragraph": true, "heading": true, "blockquote": true, "code_block": true,
	"divider": true, "image": true, "bullet_list": true, "ordered_list": true,
	// #419
	"callout": true, "pull_quote": true, "todo_list": true,
	"table": true,
	// #423
	"video": true, "audio": true, "file": true,
}

// listBlockTypes have their items as children (Block Spec `LIST_ITEMS`): list_item for
// the bulleted and numbered lists, todo_item for the to-do list (#419).
var listBlockTypes = map[string]bool{"bullet_list": true, "ordered_list": true, "todo_list": true}

// listItemBlockTypes are the lists' items: blocks with ids that only live in their list.
var listItemBlockTypes = map[string]bool{"list_item": true, "todo_item": true}

// isCoreBlockType: a type this build knows (flow, the list items, the containers).
func isCoreBlockType(t string) bool {
	_, container := blockContainers[t]
	return flowBlockTypes[t] || listItemBlockTypes[t] || container
}

// isFlowBlockType: a core flow type, or any type that isn't core (a theme block, a type
// from a newer build), which is one node holding no blocks.
func isFlowBlockType(t string) bool {
	// "" is no type (a block that isn't an object has none): never flow, as in nesting.ts.
	return t != "" && (flowBlockTypes[t] || !isCoreBlockType(t))
}

// containerAccepts reports whether a containerType block may hold a childType block.
func containerAccepts(containerType, childType string) bool {
	rule, ok := blockContainers[containerType]
	if !ok {
		return false
	}
	for _, accepted := range rule.accepts {
		if accepted == childType || (accepted == "flow" && isFlowBlockType(childType)) {
			return true
		}
	}
	return false
}

// deduplicateBlocks removes repeats within blocks_order and within each block's
// children, first occurrence kept (#414). Such docs exist, so this runs before the
// checks and never makes a stored post start failing. An id under two different parents
// is left alone: checkBlockNesting refuses it. A children array that isn't all strings
// is left alone too (checkBlockNesting refuses that as well).
func (doc *BlockDocV1) deduplicateBlocks() {
	doc.deduplicateBlocksOrder()
	for _, raw := range doc.Blocks {
		block, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		children, ok := block["children"].([]interface{})
		if !ok {
			continue
		}
		seen := make(map[string]bool, len(children))
		unique := make([]interface{}, 0, len(children))
		allStrings := true
		for _, child := range children {
			id, isString := child.(string)
			if !isString {
				allStrings = false
				break
			}
			if !seen[id] {
				seen[id] = true
				unique = append(unique, id)
			}
		}
		if allStrings && len(unique) != len(children) {
			block["children"] = unique
		}
	}
}

// checkBlockNesting returns the first structural problem of doc (design 2.3), or nil.
// Run after deduplicateBlocks. The same rules as the web's `nestingIssues`:
//
//  1. every id in blocks_order or any children is a block in blocks;
//  2. each block is referenced at most once across blocks_order and every children;
//  3. no cycles;
//  4. a container's children are of the types and in the count the table allows, and a
//     core block that is neither a container nor a list has no children.
//
// An unreferenced block is not an error. children that isn't an array of strings is.
// Theme and unknown types may have children; rules 1–3 apply to them too.
func (doc *BlockDocV1) checkBlockNesting() error {
	exists := func(id string) bool {
		v, ok := doc.Blocks[id]
		return ok && v != nil
	}
	typeOf := func(id string) string {
		block, _ := doc.Blocks[id].(map[string]interface{})
		return stringOf(block["type"])
	}
	// The parent of each referenced block ("" = blocks_order).
	parent := make(map[string]string)
	reference := func(id, from string) error {
		if !exists(id) {
			if from == "" {
				// The wording prepareForStore has always used for blocks_order.
				return fmt.Errorf("block_id %s in blocks_order not found in blocks", truncateID(id))
			}
			return fmt.Errorf("block %q: child %q not found in blocks", truncateID(from), truncateID(id))
		}
		if _, seen := parent[id]; seen {
			return fmt.Errorf("block %q is referenced more than once", truncateID(id))
		}
		parent[id] = from
		return nil
	}

	for _, id := range doc.BlocksOrder {
		if err := reference(id, ""); err != nil {
			return err
		}
	}

	keys := make([]string, 0, len(doc.Blocks))
	for key := range doc.Blocks {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		block, ok := doc.Blocks[key].(map[string]interface{})
		if !ok {
			continue
		}
		blockType := stringOf(block["type"])
		raw, hasChildren := block["children"]
		var children []string
		if hasChildren {
			list, isList := raw.([]interface{})
			if !isList {
				return fmt.Errorf("block %q: children must be an array of block ids", truncateID(key))
			}
			for _, child := range list {
				id, isString := child.(string)
				if !isString {
					return fmt.Errorf("block %q: children must be an array of block ids", truncateID(key))
				}
				children = append(children, id)
			}
		}
		if rule, isContainer := blockContainers[blockType]; isContainer {
			if len(children) < rule.min {
				return fmt.Errorf("block %q: a %s needs at least %d block(s)", truncateID(key), blockType, rule.min)
			}
			if rule.max > 0 && len(children) > rule.max {
				return fmt.Errorf("block %q: a %s holds at most %d blocks", truncateID(key), blockType, rule.max)
			}
			for _, id := range children {
				if exists(id) && !containerAccepts(blockType, typeOf(id)) {
					return fmt.Errorf("block %q: a %s can't hold a %s", truncateID(key), blockType, typeOf(id))
				}
			}
		} else if hasChildren && isCoreBlockType(blockType) && !listBlockTypes[blockType] {
			return fmt.Errorf("block %q: a %s has no children", truncateID(key), blockType)
		}
		for _, id := range children {
			if err := reference(id, key); err != nil {
				return err
			}
		}
	}

	// Rule 3. With rule 2 every block has one parent at most, so walking up from each
	// either reaches the top (or an unreferenced block) or comes back around.
	for start := range parent {
		onPath := map[string]bool{}
		at, ok := start, true
		for ok && at != "" && !onPath[at] {
			onPath[at] = true
			at, ok = parent[at]
		}
		if ok && at != "" && onPath[at] {
			return fmt.Errorf("block %q contains itself", truncateID(at))
		}
	}
	return nil
}

// Group (#414): `style` none/tinted, `align` content/wide/full (Block Spec
// `GROUP_STYLES`, `GROUP_ALIGNS`). Defaults are left out by the editor.
var groupStyles = map[string]bool{"none": true, "tinted": true}
var groupAligns = map[string]bool{"content": true, "wide": true, "full": true}

// sanitizeGroupAttrs keeps only a group's own attrs (an allowlist: anything else is
// deleted) with valid values; an invalid one is dropped, so the group renders with the
// default.
func sanitizeGroupAttrs(attrs map[string]interface{}) {
	for key, value := range attrs {
		switch key {
		case "style":
			if s, ok := value.(string); !ok || !groupStyles[s] {
				delete(attrs, key)
			}
		case "align":
			if s, ok := value.(string); !ok || !groupAligns[s] {
				delete(attrs, key)
			}
		default:
			delete(attrs, key)
		}
	}
}

// walkBlocks calls visit for each block reachable from blocks_order, in reading order
// (blocks_order, then children depth first, the search function's order), each once.
func (doc *BlockDocV1) walkBlocks(visit func(id string, block map[string]interface{})) {
	seen := make(map[string]bool)
	var walk func(id string)
	walk = func(id string) {
		if seen[id] {
			return
		}
		block, ok := doc.Blocks[id].(map[string]interface{})
		if !ok {
			return
		}
		seen[id] = true
		visit(id, block)
		if children, ok := block["children"].([]interface{}); ok {
			for _, child := range children {
				if childID, ok := child.(string); ok {
					walk(childID)
				}
			}
		}
	}
	for _, id := range doc.BlocksOrder {
		walk(id)
	}
}

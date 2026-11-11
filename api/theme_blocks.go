package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"slices"
	"strings"
	"unicode/utf8"
)

// Theme blocks (#376). A theme's custom block (e.g. `theme:example/alert`) is declared in
// TypeScript (web/themes/<slug>/blocks/<Name>/index.ts), which the API can't run, so the
// web build generates web/themes/blocks.manifest.json with every installed block's type,
// version and attrs (web/scripts/theme-blocks-manifest.mjs). The API image ships
// web/themes, and the manifest with it; adding or changing a theme block means
// rebuilding the web, collab and api images from the same commit.
//
// prepareForStore then treats a block of a type in the manifest like a core block:
// undeclared attrs are stripped, an invalid value or an unreadable version refuses the
// document (400). The collab server checks the same rules before it sends a block_doc
// (web/gl-admin/lib/blocks-spec/themeBlocks.ts), so a valid edit is never refused here;
// web/gl-admin/lib/blocks-spec/themeBlockVectors.json holds the cases both must agree on.
//
// A `theme:` or `plugin:` block (#452) whose type is not in the manifest (its theme or
// plugin was removed) is kept as it is, with only the generic sanitizer applied: refusing
// or dropping it would lose the post's content. The public renderer renders nothing for it.
// Plugin blocks' specs go into the same manifest (ThemeBlockManifest), so they get exactly
// the checks theme blocks get.

// themeBlockManifestPath is where the manifest sits relative to the working directory,
// next to the themes the startup scan reads (ScanThemesDirectory).
const themeBlockManifestPath = "web/themes/blocks.manifest.json"

// Namespaced extension blocks (#452): a theme's (`theme:<slug>/<block>`, #376) or a
// plugin's (`plugin:<slug>/<block>`, docs/design/plugin-system.md 5.1). No core type
// contains `:`. Both are the same kind of block here: a type the manifest knows is
// validated from its spec, and one it doesn't (its extension isn't in this build) is kept
// as it is. The web's `isExtensionBlockType` (blocks-spec/themeBlocks.ts) is the same rule.
var extensionBlockPrefixes = []string{"theme:", "plugin:"}

// isExtensionBlockType reports whether blockType is a theme's or a plugin's block.
func isExtensionBlockType(blockType string) bool {
	for _, prefix := range extensionBlockPrefixes {
		if strings.HasPrefix(blockType, prefix) {
			return true
		}
	}
	return false
}

// ThemeAttrSpec is one declared attribute (Block Spec `ThemeAttrSpec`).
type ThemeAttrSpec struct {
	Type      string        `json:"type"`
	Default   interface{}   `json:"default"`
	Enum      []interface{} `json:"enum,omitempty"`
	MaxLength *int          `json:"maxLength,omitempty"`
	Integer   bool          `json:"integer,omitempty"`
	Minimum   *float64      `json:"minimum,omitempty"`
	Maximum   *float64      `json:"maximum,omitempty"`
}

// ThemeBlockSpec is one installed theme block: the newest version this build reads and
// writes, and its attrs.
type ThemeBlockSpec struct {
	Version int                      `json:"version"`
	Attrs   map[string]ThemeAttrSpec `json:"attrs"`
}

// ThemeBlockManifest is web/themes/blocks.manifest.json. The zero value knows no theme
// blocks (every theme block is then kept opaque).
type ThemeBlockManifest struct {
	ManifestVersion int                       `json:"manifest_version"`
	Blocks          map[string]ThemeBlockSpec `json:"blocks"`
}

// LoadThemeBlockManifest reads the manifest. A missing file is not an error (no theme
// blocks are validated; the caller logs it). A file that exists but can't be used is: a
// build that ships a broken manifest must not start and silently accept anything.
func LoadThemeBlockManifest(path string) (ThemeBlockManifest, bool, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return ThemeBlockManifest{}, false, nil
	}
	if err != nil {
		return ThemeBlockManifest{}, false, err
	}
	var manifest ThemeBlockManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return ThemeBlockManifest{}, true, fmt.Errorf("theme block manifest %s: %w", path, err)
	}
	if manifest.ManifestVersion != 1 {
		return ThemeBlockManifest{}, true, fmt.Errorf("theme block manifest %s: unsupported manifest_version %d", path, manifest.ManifestVersion)
	}
	for blockType, spec := range manifest.Blocks {
		if !isExtensionBlockType(blockType) || spec.Version < 1 {
			return ThemeBlockManifest{}, true, fmt.Errorf("theme block manifest %s: bad entry %q", path, blockType)
		}
		for name, attr := range spec.Attrs {
			switch attr.Type {
			case "string", "number", "boolean":
			default:
				return ThemeBlockManifest{}, true, fmt.Errorf("theme block manifest %s: %s.%s has unsupported type %q", path, blockType, name, attr.Type)
			}
		}
	}
	return manifest, true, nil
}

// Attrs every theme block carries besides its declared ones: its content, written by the
// editor's bridge.
var themeBlockContentAttrs = map[string]bool{"pm": true, "text": true}

// applyThemeBlocks validates and normalises, in place, every block of a type the manifest
// knows. Unknown types (core blocks, removed themes) are left alone.
func (doc *BlockDocV1) applyThemeBlocks(manifest ThemeBlockManifest) error {
	if len(manifest.Blocks) == 0 {
		return nil
	}
	for id, raw := range doc.Blocks {
		block, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		blockType, _ := block["type"].(string)
		spec, ok := manifest.Blocks[blockType]
		if !ok {
			continue
		}
		if err := applyThemeBlock(block, spec); err != nil {
			return fmt.Errorf("block %s (%s): %w", id, blockType, err)
		}
	}
	return nil
}

func applyThemeBlock(block map[string]interface{}, spec ThemeBlockSpec) error {
	version, ok := block["version"].(float64)
	if !ok || version != math.Trunc(version) || version < 1 {
		return errors.New("version must be an integer >= 1")
	}
	if version > float64(spec.Version) {
		// Written by a newer build of the theme (e.g. before a rollback): this build can't
		// know its attrs, so it is kept as is, like a block of an uninstalled theme. The
		// collab server keeps it hidden and the public page skips it.
		return nil
	}

	attrs, ok := block["attrs"].(map[string]interface{})
	if !ok {
		if block["attrs"] != nil {
			return errors.New("attrs must be an object")
		}
		block["attrs"] = map[string]interface{}{}
		return nil
	}
	for name, value := range attrs {
		if themeBlockContentAttrs[name] {
			continue
		}
		attr, declared := spec.Attrs[name]
		if !declared || value == nil {
			delete(attrs, name) // undeclared, or unset: the default applies
			continue
		}
		if problem := themeAttrProblem(attr, value); problem != "" {
			return fmt.Errorf("attr %s %s", name, problem)
		}
	}
	// The declared attrs are canonical on the block, never in its pm (as for a quote's
	// cite): the stored pm keeps its type and content only.
	if pm, ok := attrs["pm"].(map[string]interface{}); ok {
		delete(pm, "attrs")
	}
	if text, present := attrs["text"]; present {
		if _, ok := text.(string); !ok {
			delete(attrs, "text")
		}
	}
	return nil
}

// themeAttrProblem is Block Spec `attrProblem`: "" when value is valid for attr.
func themeAttrProblem(attr ThemeAttrSpec, value interface{}) string {
	switch attr.Type {
	case "string":
		s, ok := value.(string)
		if !ok {
			return "must be a string"
		}
		if len(attr.Enum) > 0 && !slices.Contains(attr.Enum, interface{}(s)) {
			return "must be one of the declared values"
		}
		if attr.MaxLength != nil && utf8.RuneCountInString(s) > *attr.MaxLength {
			return fmt.Sprintf("must be at most %d characters", *attr.MaxLength)
		}
	case "number":
		n, ok := value.(float64)
		if !ok || math.IsNaN(n) || math.IsInf(n, 0) {
			return "must be a number"
		}
		if attr.Integer && n != math.Trunc(n) {
			return "must be an integer"
		}
		if len(attr.Enum) > 0 && !slices.ContainsFunc(attr.Enum, func(e interface{}) bool { f, ok := e.(float64); return ok && f == n }) {
			return "must be one of the declared values"
		}
		if attr.Minimum != nil && n < *attr.Minimum {
			return fmt.Sprintf("must be at least %v", *attr.Minimum)
		}
		if attr.Maximum != nil && n > *attr.Maximum {
			return fmt.Sprintf("must be at most %v", *attr.Maximum)
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			return "must be a boolean"
		}
	default:
		return "has an unsupported type"
	}
	return ""
}

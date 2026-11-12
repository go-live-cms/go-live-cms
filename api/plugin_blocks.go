package api

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

// Plugin content blocks (#456, docs/design/plugin-system.md 5.1 and 5.2).
//
// A plugin block is web/plugins/<slug>/blocks/<Name>/block.json: the exact inputs of the web's
// defineThemeBlock as data, `{type, version, title, content?, marks?, attrs?}`. Being data, the
// collab server bundles it without any plugin JavaScript and this process validates it without
// running anything. The type is `plugin:<slug>/<name in lowercase>`.
//
// The startup scan (loadPluginDir) validates every declared block's block.json of a plugin
// whose plugin_api core implements; one that fails makes the plugin invalid (`incompatible`,
// like a bad plugin.json). The specs of the plugins that load are merged into
// server.themeBlocks (mergePluginBlockSpecs), so applyThemeBlocks validates plugin blocks
// exactly as it validates theme blocks. Installed, never enabled: enabling or disabling a
// plugin doesn't change what is validated (design 5.3), and a block of a plugin that isn't
// installed is kept as it is (theme_blocks.go).
//
// This is the one validator of block.json besides its TypeScript twin
// (web/gl-admin/lib/plugins/blockJson.ts); web/gl-admin/lib/plugins/pluginBlockVectors.json
// holds the cases both suites run (TestPluginBlockVectors, blockJson.test.ts), and both report
// the first problem with the same field path.

const pluginBlockFile = "block.json"

// pluginBlockMaxBytes caps block.json. Real ones are a few hundred bytes.
const pluginBlockMaxBytes = 64 << 10

// Limits shared with blockJson.ts (PLUGIN_BLOCK_LIMITS).
const (
	pluginBlockTitleMax      = 100
	pluginBlockVersionMax    = 1_000_000
	pluginBlockAttrsMax      = 50
	pluginBlockEnumMax       = 100
	pluginBlockExpressionMax = 200
	pluginBlockMaxLengthMax  = 100_000
)

// extensionBlockContentNames are the node types and groups a theme or plugin block's content
// expression may name: text and text blocks only, so no block or media hides in its pm
// (#414). The web's THEME_BLOCK_CONTENT_NAMES (theme-blocks/installed.ts); blockJson.test.ts
// fails if the two lists differ.
var extensionBlockContentNames = []string{"inline", "text", "hardBreak", "paragraph", "heading", "codeBlock", "horizontalRule"}

var (
	pluginBlockFields = []string{"attrs", "content", "marks", "title", "type", "version"}
	pluginAttrFields  = map[string][]string{
		"string":  {"default", "enum", "maxLength", "type"},
		"number":  {"default", "enum", "integer", "maximum", "minimum", "type"},
		"boolean": {"default", "type"},
	}
	// Same as blocks-spec/themeBlocks.ts (ATTR_NAME, RESERVED_ATTR).
	pluginAttrNameRe     = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9]*$`)
	pluginReservedAttrRe = regexp.MustCompile(`(?i)^(pm|text|data-block-id|on.*)$`)
	pluginNameTokenRe    = regexp.MustCompile(`[A-Za-z_][\w-]*`)
	// Whitespace spelled out, as in blockJson.ts: \s differs between Go and JS.
	pluginExpressionRe = regexp.MustCompile(`^[A-Za-z0-9_\- \t\n\r|*+?(){},]*$`)
	pluginMarksRe      = regexp.MustCompile(`^[A-Za-z0-9_ \t\n\r]*$`)
)

// PluginBlockError is why a plugin's block.json can't be used: Field is the path of the first
// problem (the vectors' `field`).
type PluginBlockError struct {
	Block   string
	Field   string
	Message string
}

func (e *PluginBlockError) Error() string {
	if e.Field == "" {
		return fmt.Sprintf("blocks/%s/block.json %s", e.Block, e.Message)
	}
	return fmt.Sprintf("blocks/%s/block.json: %s %s", e.Block, e.Field, e.Message)
}

// pluginBlockTypeFor is the type blocks/<dir>/ must declare: plugin.json's block names are
// unique ignoring case for exactly this reason (validatePluginBlocks).
func pluginBlockTypeFor(slug, dir string) string {
	return "plugin:" + slug + "/" + strings.ToLower(dir)
}

// ValidatePluginBlockJSON checks value, a parsed block.json of plugins/<slug>/blocks/<dir>/,
// and returns its spec.
func ValidatePluginBlockJSON(value any, slug, dir string) (string, ThemeBlockSpec, *PluginBlockError) {
	problem := func(field, format string, args ...any) *PluginBlockError {
		return &PluginBlockError{Block: dir, Field: field, Message: fmt.Sprintf(format, args...)}
	}
	block, ok := value.(map[string]any)
	if !ok {
		return "", ThemeBlockSpec{}, problem("", "must be a JSON object")
	}
	if err := unknownFields(block, pluginBlockFields, "", "is not a block.json field"); err != nil {
		return "", ThemeBlockSpec{}, problem(err.Field, "%s", err.Message)
	}

	rawType, present := block["type"]
	if !present {
		return "", ThemeBlockSpec{}, problem("type", "is required")
	}
	expected := pluginBlockTypeFor(slug, dir)
	if blockType, _ := rawType.(string); blockType != expected {
		return "", ThemeBlockSpec{}, problem("type", "must be %q (plugin:<plugin id>/<directory name in lowercase>)", expected)
	}

	rawVersion, present := block["version"]
	if !present {
		return "", ThemeBlockSpec{}, problem("version", "is required")
	}
	version, ok := rawVersion.(float64)
	if !ok || !isInteger(version) || version < 1 || version > pluginBlockVersionMax {
		return "", ThemeBlockSpec{}, problem("version", "must be an integer from 1 to %d", pluginBlockVersionMax)
	}

	title, err := requiredString(block, "title")
	if err != nil {
		return "", ThemeBlockSpec{}, problem(err.Field, "%s", err.Message)
	}
	if isBlank(title) {
		return "", ThemeBlockSpec{}, problem("title", "must not be blank")
	}
	if utf8.RuneCountInString(title) > pluginBlockTitleMax {
		return "", ThemeBlockSpec{}, problem("title", "must be at most %d characters", pluginBlockTitleMax)
	}

	if raw, present := block["content"]; present {
		content, ok := raw.(string)
		if !ok {
			return "", ThemeBlockSpec{}, problem("content", "must be a string")
		}
		if len(content) > pluginBlockExpressionMax || !pluginExpressionRe.MatchString(content) {
			return "", ThemeBlockSpec{}, problem("content", "must be a ProseMirror content expression, at most %d characters", pluginBlockExpressionMax)
		}
		for _, name := range pluginNameTokenRe.FindAllString(content, -1) {
			if !slices.Contains(extensionBlockContentNames, name) {
				return "", ThemeBlockSpec{}, problem("content", "may only name %s (a plugin block holds text only), not %s", strings.Join(extensionBlockContentNames, ", "), name)
			}
		}
	}

	if raw, present := block["marks"]; present {
		marks, ok := raw.(string)
		if !ok {
			return "", ThemeBlockSpec{}, problem("marks", "must be a string")
		}
		if len(marks) > pluginBlockExpressionMax || !pluginMarksRe.MatchString(marks) {
			return "", ThemeBlockSpec{}, problem("marks", "must be mark names separated by spaces, or _, at most %d characters", pluginBlockExpressionMax)
		}
	}

	rawAttrs, hasAttrs := block["attrs"]
	attrs, attrErr := pluginBlockAttrs(rawAttrs, hasAttrs, problem)
	if attrErr != nil {
		return "", ThemeBlockSpec{}, attrErr
	}
	return expected, ThemeBlockSpec{Version: int(version), Attrs: attrs}, nil
}

func pluginBlockAttrs(value any, present bool, problem func(field, format string, args ...any) *PluginBlockError) (map[string]ThemeAttrSpec, *PluginBlockError) {
	attrs := map[string]ThemeAttrSpec{}
	if !present {
		return attrs, nil // absent: no attrs (JSON null is refused below, as in blockJson.ts)
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, problem("attrs", "must be an object")
	}
	names := sortedManifestKeys(object)
	if len(names) > pluginBlockAttrsMax {
		return nil, problem("attrs", "must have at most %d attrs", pluginBlockAttrsMax)
	}
	for _, name := range names {
		field := "attrs." + name
		if !pluginAttrNameRe.MatchString(name) || pluginReservedAttrRe.MatchString(name) {
			return nil, problem(field, "must be letters and digits, start with a letter, and not be pm, text or on…")
		}
		attr, ok := object[name].(map[string]any)
		if !ok {
			return nil, problem(field, "must be an object")
		}
		rawType, present := attr["type"]
		if !present {
			return nil, problem(field+".type", "is required")
		}
		attrType, _ := rawType.(string)
		allowed, known := pluginAttrFields[attrType]
		if !known {
			return nil, problem(field+".type", "must be string, number or boolean")
		}
		if err := unknownFields(attr, allowed, field+".", "is not a "+attrType+" attr field"); err != nil {
			return nil, problem(err.Field, "%s", err.Message)
		}
		spec, err := pluginAttrSpec(field, attrType, attr, problem)
		if err != nil {
			return nil, err
		}
		attrs[name] = spec
	}
	return attrs, nil
}

func pluginAttrSpec(field, attrType string, attr map[string]any, problem func(field, format string, args ...any) *PluginBlockError) (ThemeAttrSpec, *PluginBlockError) {
	spec := ThemeAttrSpec{Type: attrType}
	finite := func(value any) (float64, bool) {
		n, ok := value.(float64)
		return n, ok && !math.IsNaN(n) && !math.IsInf(n, 0)
	}
	if attrType == "number" {
		if raw, present := attr["integer"]; present {
			integer, ok := raw.(bool)
			if !ok {
				return spec, problem(field+".integer", "must be true or false")
			}
			spec.Integer = integer
		}
		for _, key := range []string{"minimum", "maximum"} {
			raw, present := attr[key]
			if !present {
				continue
			}
			n, ok := finite(raw)
			if !ok {
				return spec, problem(field+"."+key, "must be a number")
			}
			if key == "minimum" {
				spec.Minimum = &n
			} else {
				spec.Maximum = &n
			}
		}
		if spec.Minimum != nil && spec.Maximum != nil && *spec.Minimum > *spec.Maximum {
			return spec, problem(field+".maximum", "must not be less than minimum")
		}
	}
	if raw, present := attr["maxLength"]; present && attrType == "string" {
		n, ok := raw.(float64)
		if !ok || !isInteger(n) || n < 1 || n > pluginBlockMaxLengthMax {
			return spec, problem(field+".maxLength", "must be an integer from 1 to %d", pluginBlockMaxLengthMax)
		}
		maxLength := int(n)
		spec.MaxLength = &maxLength
	}
	if raw, present := attr["enum"]; present {
		values, ok := raw.([]any)
		if !ok || len(values) == 0 || len(values) > pluginBlockEnumMax {
			return spec, problem(field+".enum", "must be an array of 1 to %d values", pluginBlockEnumMax)
		}
		for i, item := range values {
			itemField := fmt.Sprintf("%s.enum[%d]", field, i)
			var valid bool
			if attrType == "string" {
				_, valid = item.(string)
			} else {
				_, valid = finite(item)
			}
			if !valid {
				return spec, problem(itemField, "must be a %s", attrType)
			}
			if slices.Contains(values[:i], item) {
				return spec, problem(itemField, "is listed twice")
			}
		}
		spec.Enum = values
	}
	def, present := attr["default"]
	if !present || def == nil {
		return spec, problem(field+".default", "is required")
	}
	if themeAttrProblem(spec, def) != "" {
		return spec, problem(field+".default", "must be a valid value of the attr")
	}
	spec.Default = def
	return spec, nil
}

// loadPluginBlocks reads and validates the block.json of every block plugin.json declares,
// and refuses a blocks/<dir>/block.json it doesn't declare (the web build refuses both too).
func loadPluginBlocks(slug, dir string, declared []string) (map[string]ThemeBlockSpec, error) {
	specs := map[string]ThemeBlockSpec{}
	for _, name := range declared {
		raw, err := readPluginBlockFile(filepath.Join(dir, "blocks", name, pluginBlockFile))
		if err != nil {
			if os.IsNotExist(err) {
				return nil, &PluginBlockError{Block: name, Message: "is missing"}
			}
			return nil, fmt.Errorf("blocks/%s/block.json: %w", name, err)
		}
		var value any
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil, &PluginBlockError{Block: name, Message: "is not valid JSON"}
		}
		blockType, spec, problem := ValidatePluginBlockJSON(value, slug, name)
		if problem != nil {
			return nil, problem
		}
		specs[blockType] = spec
	}
	entries, err := os.ReadDir(filepath.Join(dir, "blocks"))
	if err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("read blocks: %w", err)
	}
	for _, entry := range entries {
		if !entry.IsDir() || slices.Contains(declared, entry.Name()) {
			continue
		}
		if _, err := os.Stat(filepath.Join(dir, "blocks", entry.Name(), pluginBlockFile)); err == nil {
			return nil, &PluginBlockError{Block: entry.Name(), Message: `is not listed in plugin.json's "blocks"`}
		}
	}
	return specs, nil
}

func readPluginBlockFile(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Size() > pluginBlockMaxBytes {
		return nil, fmt.Errorf("is larger than %d bytes", pluginBlockMaxBytes)
	}
	return os.ReadFile(path)
}

// mergePluginBlockSpecs returns manifest plus the block specs of every plugin that loaded
// (no Err, plugin_api in core's range), the set the web build installs (lib/plugins/
// blocks.ts). A type already in the manifest isn't overridden (none can be: theme and plugin
// types differ by namespace, and a plugin's types carry its slug).
func mergePluginBlockSpecs(manifest ThemeBlockManifest, plugins []DiscoveredPlugin) (ThemeBlockManifest, []string) {
	merged := ThemeBlockManifest{ManifestVersion: 1, Blocks: map[string]ThemeBlockSpec{}}
	for blockType, spec := range manifest.Blocks {
		merged.Blocks[blockType] = spec
	}
	var added []string
	for _, plugin := range plugins {
		if plugin.Err != nil || !pluginAPICompatible(plugin.Manifest.PluginAPI) {
			continue
		}
		for blockType, spec := range plugin.BlockSpecs {
			if _, exists := merged.Blocks[blockType]; exists {
				continue
			}
			merged.Blocks[blockType] = spec
			added = append(added, blockType)
		}
	}
	slices.Sort(added)
	return merged, added
}

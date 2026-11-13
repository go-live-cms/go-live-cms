package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"unicode/utf8"
)

// Plugin packages and their manifest (#455, docs/design/plugin-system.md section 3).
//
// A plugin is a directory web/plugins/<slug>/ with a plugin.json. It lives under web/
// because the web and collab images build with web/ as their context; the API image
// copies web/plugins as it copies web/themes (Dockerfile, .dockerignore). Installing a
// plugin means shipping it in the image: the startup scan (ScanPluginsDirectory, next
// to ScanThemesDirectory in themes_scanner.go) registers what it finds.
//
// This file is the one validator of plugin.json. The admin's copy
// (web/gl-admin/lib/plugins/manifest.ts) must accept and refuse the same manifests, and
// web/gl-admin/lib/plugins/pluginManifestVectors.json holds the cases both suites run
// (TestPluginManifestVectors and manifest.test.ts). Both suites also validate every
// plugin in the repository, so one that fails fails CI. Checks run in a fixed order and
// report the first problem, with the same field path on both sides.

// pluginsPath is where the plugins sit relative to the working directory, next to
// web/themes.
const pluginsPath = "web/plugins"

const pluginManifestFile = "plugin.json"

// pluginManifestMaxBytes caps plugin.json. Real manifests are a few hundred bytes.
const pluginManifestMaxBytes = 64 << 10

// The extension contract core implements. A plugin declares the plugin_api it was
// written against; outside this range it is listed as incompatible and can't be
// enabled. Images are tagged by commit and there are no releases, so this is a
// number, not a GoLive version range (section 3). Keep manifest.ts's PLUGIN_API equal.
const (
	PluginAPIMin = 1
	PluginAPIMax = 1
)

func pluginAPICompatible(api int) bool {
	return api >= PluginAPIMin && api <= PluginAPIMax
}

// Plugin statuses (000054's CHECK).
const (
	PluginStatusInstalled    = "installed"
	PluginStatusMissing      = "missing"
	PluginStatusIncompatible = "incompatible"
)

var (
	pluginIDRe         = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)
	pluginBlockNameRe  = regexp.MustCompile(`^[A-Z][A-Za-z0-9]{0,63}$`)
	pluginSettingKeyRe = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
	// Semantic Versioning 2.0.0's own expression (semver.org).
	pluginSemverRe = regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$`)
)

// reservedPluginIDs can't be plugin ids: `enabled` is GET /plugins/enabled, which
// would hide GET /plugins/:slug for such a plugin.
var reservedPluginIDs = map[string]bool{"enabled": true}

// PluginCapabilities are what a plugin may declare it uses (section 2). Declared and
// shown; not a security boundary in Beta.
var PluginCapabilities = []string{"posts:read", "media:read", "users:read", "network"}

// PluginHookEvents are the events a hook may subscribe to (section 7.2);
// post.before_publish is the publish guard (7.7).
var PluginHookEvents = []string{
	"post.saved", "post.published", "post.unpublished", "post.trashed", "post.restored", "post.deleted",
	pluginGuardEvent,
}

const pluginGuardEvent = "post.before_publish"

// Limits. They match manifest.ts.
const (
	pluginNameMax          = 100
	pluginAuthorMax        = 100
	pluginDescriptionMax   = 1000
	pluginVersionMax       = 64
	pluginBlocksMax        = 50
	pluginSettingsMax      = 50
	pluginSettingEnumMax   = 100
	pluginSettingLabelMax  = 100
	pluginSettingDescMax   = 500
	pluginSettingLengthMax = 10000
	pluginHooksMax         = 16
	pluginHookTimeoutMax   = 30000
	pluginGuardPriorityMax = 1000
	// pluginAPIMax bounds plugin_api so it always fits an int (and core's range is far below it).
	pluginAPIMax = 1000000
)

// PluginManifest is a validated plugin.json.
type PluginManifest struct {
	ManifestVersion int                          `json:"manifest_version"`
	ID              string                       `json:"id"`
	Name            string                       `json:"name"`
	Version         string                       `json:"version"`
	Author          string                       `json:"author"`
	Description     string                       `json:"description"`
	PluginAPI       int                          `json:"plugin_api"`
	Capabilities    []string                     `json:"capabilities"`
	Blocks          []string                     `json:"blocks"`
	Settings        map[string]PluginSettingSpec `json:"settings"`
	Server          PluginServer                 `json:"server"`
}

// PluginSettingSpec is one field of the settings panel (section 6): the theme block
// attr vocabulary, plus how the form shows it.
type PluginSettingSpec struct {
	ThemeAttrSpec
	Label       string `json:"label,omitempty"`
	Description string `json:"description,omitempty"`
	// Secret fields are write-only (section 6).
	Secret bool `json:"secret,omitempty"`
}

// PluginServer is the manifest's `server` object.
type PluginServer struct {
	Hooks []PluginHook `json:"hooks"`
	// Webhook, when set, delivers every hook in Hooks to a URL instead of to Go code
	// (#460, design section 7.9): a plugin with no server/ package can have hooks.
	Webhook *PluginWebhook `json:"webhook,omitempty"`
}

// PluginWebhook names the two settings a webhook plugin's delivery reads: the URL an
// admin enters, and the secret it is signed with (a "secret": true field, so rotating it
// is saving a new value).
type PluginWebhook struct {
	URLSetting    string `json:"url_setting"`
	SecretSetting string `json:"secret_setting"`
}

// PluginHook is one declared hook (section 7).
type PluginHook struct {
	Event     string `json:"event"`
	TimeoutMS int    `json:"timeout_ms,omitempty"`
	OnError   string `json:"on_error,omitempty"`
	Priority  int    `json:"priority,omitempty"`
}

// PluginManifestError is the first problem found in a manifest. Field is a path into
// it ("id", "settings.words_per_minute.default", "server.hooks[0].event"); "" is the
// document itself.
type PluginManifestError struct {
	Field   string
	Message string
}

func (e *PluginManifestError) Error() string {
	if e.Field == "" {
		return "plugin.json " + e.Message
	}
	return fmt.Sprintf("plugin.json: %s %s", e.Field, e.Message)
}

func manifestProblem(field, format string, args ...any) *PluginManifestError {
	return &PluginManifestError{Field: field, Message: fmt.Sprintf(format, args...)}
}

// ParsePluginManifest validates raw as the plugin.json of directory dir and returns
// it typed, plus its normalized JSON (what the plugins table stores).
func ParsePluginManifest(raw []byte, dir string) (PluginManifest, json.RawMessage, error) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return PluginManifest{}, nil, manifestProblem("", "is not valid JSON")
	}
	if problem := validatePluginManifestValue(value, dir); problem != nil {
		return PluginManifest{}, nil, problem
	}
	normalized, err := json.Marshal(value)
	if err != nil {
		return PluginManifest{}, nil, err
	}
	var manifest PluginManifest
	if err := json.Unmarshal(normalized, &manifest); err != nil {
		return PluginManifest{}, nil, err
	}
	return manifest, normalized, nil
}

var pluginManifestFields = []string{
	"manifest_version", "id", "name", "version", "author", "description", "plugin_api",
	"capabilities", "blocks", "settings", "server",
}

// validatePluginManifestValue checks a decoded plugin.json. Numbers are float64, as
// encoding/json decodes them into any.
func validatePluginManifestValue(value any, dir string) *PluginManifestError {
	manifest, ok := value.(map[string]any)
	if !ok {
		return manifestProblem("", "must be a JSON object")
	}
	if problem := unknownFields(manifest, pluginManifestFields, "", "is not a manifest field"); problem != nil {
		return problem
	}

	if version, present := manifest["manifest_version"]; !present {
		return manifestProblem("manifest_version", "is required")
	} else if n, ok := version.(float64); !ok || n != 1 {
		return manifestProblem("manifest_version", "must be 1")
	}

	id, problem := requiredString(manifest, "id")
	if problem != nil {
		return problem
	}
	switch {
	case !pluginIDRe.MatchString(id):
		return manifestProblem("id", "must be lowercase letters, digits and hyphens, start with a letter, at most 63 characters")
	case reservedPluginIDs[id]:
		return manifestProblem("id", "is reserved")
	case id != dir:
		return manifestProblem("id", "must equal the plugin's directory name (%s)", dir)
	}

	name, problem := requiredString(manifest, "name")
	if problem != nil {
		return problem
	}
	if isBlank(name) {
		return manifestProblem("name", "must not be blank")
	}
	if utf8.RuneCountInString(name) > pluginNameMax {
		return manifestProblem("name", "must be at most %d characters", pluginNameMax)
	}

	version, problem := requiredString(manifest, "version")
	if problem != nil {
		return problem
	}
	if len(version) > pluginVersionMax || !pluginSemverRe.MatchString(version) {
		return manifestProblem("version", "must be a semantic version (1.2.0), at most %d characters", pluginVersionMax)
	}

	if problem := optionalString(manifest, "author", pluginAuthorMax); problem != nil {
		return problem
	}
	if problem := optionalString(manifest, "description", pluginDescriptionMax); problem != nil {
		return problem
	}

	if api, present := manifest["plugin_api"]; !present {
		return manifestProblem("plugin_api", "is required")
	} else if n, ok := api.(float64); !ok || !isInteger(n) || n < 1 || n > pluginAPIMax {
		return manifestProblem("plugin_api", "must be an integer from 1 to %d", pluginAPIMax)
	}

	if problem := validatePluginCapabilities(manifest["capabilities"]); problem != nil {
		return problem
	}
	if problem := validatePluginBlocks(manifest["blocks"]); problem != nil {
		return problem
	}
	if problem := validatePluginSettings(manifest["settings"]); problem != nil {
		return problem
	}
	if problem := validatePluginServer(manifest["server"]); problem != nil {
		return problem
	}
	return validatePluginWebhook(manifest)
}

func validatePluginCapabilities(value any) *PluginManifestError {
	if value == nil {
		return nil
	}
	list, ok := value.([]any)
	if !ok {
		return manifestProblem("capabilities", "must be an array")
	}
	seen := map[string]bool{}
	for i, item := range list {
		field := fmt.Sprintf("capabilities[%d]", i)
		capability, ok := item.(string)
		if !ok || !slices.Contains(PluginCapabilities, capability) {
			return manifestProblem(field, "must be one of %s", strings.Join(PluginCapabilities, ", "))
		}
		if seen[capability] {
			return manifestProblem(field, "is declared twice")
		}
		seen[capability] = true
	}
	return nil
}

func validatePluginBlocks(value any) *PluginManifestError {
	if value == nil {
		return nil
	}
	list, ok := value.([]any)
	if !ok {
		return manifestProblem("blocks", "must be an array")
	}
	if len(list) > pluginBlocksMax {
		return manifestProblem("blocks", "must have at most %d entries", pluginBlocksMax)
	}
	seen := map[string]bool{}
	for i, item := range list {
		field := fmt.Sprintf("blocks[%d]", i)
		name, ok := item.(string)
		if !ok || !pluginBlockNameRe.MatchString(name) {
			return manifestProblem(field, "must be a block directory name: a capital letter, then letters and digits, at most 64 characters")
		}
		// Block types are derived from these names, so two that differ only in case
		// would collide.
		key := strings.ToLower(name)
		if seen[key] {
			return manifestProblem(field, "is declared twice")
		}
		seen[key] = true
	}
	return nil
}

var pluginSettingFields = []string{
	"type", "default", "enum", "maxLength", "integer", "minimum", "maximum", "label", "description", "secret",
}

// pluginSettingTypeFields are the type-specific fields each type allows.
var pluginSettingTypeFields = map[string][]string{
	"string":  {"enum", "maxLength", "secret"},
	"number":  {"enum", "integer", "minimum", "maximum"},
	"boolean": {},
}

func validatePluginSettings(value any) *PluginManifestError {
	if value == nil {
		return nil
	}
	settings, ok := value.(map[string]any)
	if !ok {
		return manifestProblem("settings", "must be an object")
	}
	if len(settings) > pluginSettingsMax {
		return manifestProblem("settings", "must have at most %d fields", pluginSettingsMax)
	}
	for _, key := range sortedManifestKeys(settings) {
		if !pluginSettingKeyRe.MatchString(key) {
			return manifestProblem("settings."+key, "must be lowercase letters, digits and underscores, start with a letter, at most 64 characters")
		}
		if problem := validatePluginSetting("settings."+key, settings[key]); problem != nil {
			return problem
		}
	}
	return nil
}

func validatePluginSetting(field string, value any) *PluginManifestError {
	spec, ok := value.(map[string]any)
	if !ok {
		return manifestProblem(field, "must be an object")
	}
	if problem := unknownFields(spec, pluginSettingFields, field+".", "is not a setting field"); problem != nil {
		return problem
	}
	kind, ok := spec["type"].(string)
	if _, known := pluginSettingTypeFields[kind]; !ok || !known {
		return manifestProblem(field+".type", "must be string, number or boolean")
	}
	for _, name := range []string{"enum", "maxLength", "secret", "integer", "minimum", "maximum"} {
		if _, present := spec[name]; present && !slices.Contains(pluginSettingTypeFields[kind], name) {
			return manifestProblem(field+"."+name, "is not allowed for type %s", kind)
		}
	}

	attr := ThemeAttrSpec{Type: kind}
	if raw, present := spec["integer"]; present {
		b, ok := raw.(bool)
		if !ok {
			return manifestProblem(field+".integer", "must be a boolean")
		}
		attr.Integer = b
	}
	if raw, present := spec["enum"]; present {
		list, ok := raw.([]any)
		if !ok || len(list) == 0 || len(list) > pluginSettingEnumMax {
			return manifestProblem(field+".enum", "must be an array of 1 to %d values", pluginSettingEnumMax)
		}
		for i, item := range list {
			itemField := fmt.Sprintf("%s.enum[%d]", field, i)
			switch kind {
			case "string":
				if _, ok := item.(string); !ok {
					return manifestProblem(itemField, "must be a string")
				}
			case "number":
				n, ok := item.(float64)
				if !ok || (attr.Integer && !isInteger(n)) {
					return manifestProblem(itemField, "must be a number of the setting's kind")
				}
			}
			if slices.Index(list, item) != i {
				return manifestProblem(itemField, "is listed twice")
			}
		}
		attr.Enum = list
	}
	if raw, present := spec["maxLength"]; present {
		n, ok := raw.(float64)
		if !ok || !isInteger(n) || n < 1 || n > pluginSettingLengthMax {
			return manifestProblem(field+".maxLength", "must be an integer from 1 to %d", pluginSettingLengthMax)
		}
		length := int(n)
		attr.MaxLength = &length
	}
	for _, name := range []string{"minimum", "maximum"} {
		raw, present := spec[name]
		if !present {
			continue
		}
		n, ok := raw.(float64)
		if !ok {
			return manifestProblem(field+"."+name, "must be a number")
		}
		if name == "minimum" {
			attr.Minimum = &n
		} else {
			attr.Maximum = &n
		}
	}
	if attr.Minimum != nil && attr.Maximum != nil && *attr.Maximum < *attr.Minimum {
		return manifestProblem(field+".maximum", "must be at least the minimum")
	}
	if raw, present := spec["secret"]; present {
		if _, ok := raw.(bool); !ok {
			return manifestProblem(field+".secret", "must be a boolean")
		}
	}
	if problem := optionalString(spec, "label", pluginSettingLabelMax, field+"."); problem != nil {
		return problem
	}
	if problem := optionalString(spec, "description", pluginSettingDescMax, field+"."); problem != nil {
		return problem
	}
	if raw, present := spec["default"]; present {
		// The value rules a stored setting is checked with (Block Spec attrProblem).
		if problem := themeAttrProblem(attr, raw); problem != "" {
			return manifestProblem(field+".default", "%s", problem)
		}
	}
	return nil
}

var (
	pluginServerFields  = []string{"hooks", "webhook"}
	pluginHookFields    = []string{"event", "timeout_ms", "on_error", "priority"}
	pluginWebhookFields = []string{"url_setting", "secret_setting"}
)

// validatePluginWebhook checks server.webhook (#460), once the settings, capabilities and
// hooks are known to be well formed: it names a string setting for the URL and a
// different, secret string setting for the signing key; the plugin declares the network
// capability (it makes outbound calls, through core); and it has at least one hook, none
// of them the publish guard, which runs synchronously before a publish and can't wait on
// a remote server.
func validatePluginWebhook(manifest map[string]any) *PluginManifestError {
	server, _ := manifest["server"].(map[string]any)
	raw, present := server["webhook"]
	if !present || raw == nil {
		return nil
	}
	webhook, ok := raw.(map[string]any)
	if !ok {
		return manifestProblem("server.webhook", "must be an object")
	}
	if problem := unknownFields(webhook, pluginWebhookFields, "server.webhook.", "is not a webhook field"); problem != nil {
		return problem
	}
	settings, _ := manifest["settings"].(map[string]any)
	urlSetting, problem := webhookSettingName(webhook, settings, "url_setting")
	if problem != nil {
		return problem
	}
	secretSetting, problem := webhookSettingName(webhook, settings, "secret_setting")
	if problem != nil {
		return problem
	}
	if secretSetting == urlSetting {
		return manifestProblem("server.webhook.secret_setting", "must differ from url_setting")
	}
	secretSpec, _ := settings[secretSetting].(map[string]any)
	if secret, _ := secretSpec["secret"].(bool); !secret {
		return manifestProblem("server.webhook.secret_setting", `must name a setting with "secret": true`)
	}

	capabilities, _ := manifest["capabilities"].([]any)
	if !slices.Contains(capabilities, any("network")) {
		return manifestProblem("capabilities", "must include network when server.webhook is set")
	}
	hooks, _ := server["hooks"].([]any)
	if len(hooks) == 0 {
		return manifestProblem("server.hooks", "must declare at least one hook when server.webhook is set")
	}
	for i, item := range hooks {
		hook, _ := item.(map[string]any)
		if event, _ := hook["event"].(string); event == pluginGuardEvent {
			return manifestProblem(fmt.Sprintf("server.hooks[%d].event", i), "can't be delivered by a webhook (%s is a publish guard)", pluginGuardEvent)
		}
	}
	return nil
}

// webhookSettingName reads server.webhook[key]: the name of a string setting.
func webhookSettingName(webhook, settings map[string]any, key string) (string, *PluginManifestError) {
	field := "server.webhook." + key
	raw, present := webhook[key]
	if !present {
		return "", manifestProblem(field, "is required")
	}
	name, ok := raw.(string)
	if !ok {
		return "", manifestProblem(field, "must be a string")
	}
	spec, declared := settings[name].(map[string]any)
	if !declared {
		return "", manifestProblem(field, "must name a field in settings")
	}
	if spec["type"] != "string" || spec["enum"] != nil {
		return "", manifestProblem(field, "must name a string setting without enum")
	}
	return name, nil
}

func validatePluginServer(value any) *PluginManifestError {
	if value == nil {
		return nil
	}
	server, ok := value.(map[string]any)
	if !ok {
		return manifestProblem("server", "must be an object")
	}
	if problem := unknownFields(server, pluginServerFields, "server.", "is not a server field"); problem != nil {
		return problem
	}
	raw, present := server["hooks"]
	if !present || raw == nil {
		return nil
	}
	hooks, ok := raw.([]any)
	if !ok {
		return manifestProblem("server.hooks", "must be an array")
	}
	if len(hooks) > pluginHooksMax {
		return manifestProblem("server.hooks", "must have at most %d entries", pluginHooksMax)
	}
	seen := map[string]bool{}
	for i, item := range hooks {
		field := fmt.Sprintf("server.hooks[%d]", i)
		hook, ok := item.(map[string]any)
		if !ok {
			return manifestProblem(field, "must be an object")
		}
		if problem := unknownFields(hook, pluginHookFields, field+".", "is not a hook field"); problem != nil {
			return problem
		}
		event, ok := hook["event"].(string)
		if !ok || !slices.Contains(PluginHookEvents, event) {
			return manifestProblem(field+".event", "must be one of %s", strings.Join(PluginHookEvents, ", "))
		}
		if seen[event] {
			return manifestProblem(field+".event", "is declared twice")
		}
		seen[event] = true
		guard := event == pluginGuardEvent

		if raw, present := hook["timeout_ms"]; present {
			if guard {
				return manifestProblem(field+".timeout_ms", "is not allowed for %s (guards have a fixed budget)", pluginGuardEvent)
			}
			if n, ok := raw.(float64); !ok || !isInteger(n) || n < 1 || n > pluginHookTimeoutMax {
				return manifestProblem(field+".timeout_ms", "must be an integer from 1 to %d", pluginHookTimeoutMax)
			}
		}
		if raw, present := hook["on_error"]; present {
			if !guard {
				return manifestProblem(field+".on_error", "is only allowed for %s", pluginGuardEvent)
			}
			if s, ok := raw.(string); !ok || (s != "allow" && s != "deny") {
				return manifestProblem(field+".on_error", "must be allow or deny")
			}
		}
		if raw, present := hook["priority"]; present {
			if !guard {
				return manifestProblem(field+".priority", "is only allowed for %s", pluginGuardEvent)
			}
			if n, ok := raw.(float64); !ok || !isInteger(n) || math.Abs(n) > pluginGuardPriorityMax {
				return manifestProblem(field+".priority", "must be an integer from -%d to %d", pluginGuardPriorityMax, pluginGuardPriorityMax)
			}
		}
	}
	return nil
}

// unknownFields reports the first key of object (in sorted order) not in allowed.
func unknownFields(object map[string]any, allowed []string, prefix, message string) *PluginManifestError {
	for _, key := range sortedManifestKeys(object) {
		if !slices.Contains(allowed, key) {
			return manifestProblem(prefix+key, "%s", message)
		}
	}
	return nil
}

func requiredString(object map[string]any, key string) (string, *PluginManifestError) {
	raw, present := object[key]
	if !present {
		return "", manifestProblem(key, "is required")
	}
	s, ok := raw.(string)
	if !ok {
		return "", manifestProblem(key, "must be a string")
	}
	return s, nil
}

// optionalString checks object[key], when present, is a string of at most max
// characters. prefix is the object's own path ("settings.x."), if any.
func optionalString(object map[string]any, key string, max int, prefix ...string) *PluginManifestError {
	field := strings.Join(prefix, "") + key
	raw, present := object[key]
	if !present {
		return nil
	}
	s, ok := raw.(string)
	if !ok {
		return manifestProblem(field, "must be a string")
	}
	if utf8.RuneCountInString(s) > max {
		return manifestProblem(field, "must be at most %d characters", max)
	}
	return nil
}

// isBlank is "only ASCII whitespace": the same rule as manifest.ts, where \s would
// mean more than Go's.
func isBlank(s string) bool {
	return strings.Trim(s, " \t\n\r") == ""
}

func isInteger(n float64) bool {
	return n == math.Trunc(n) && !math.IsInf(n, 0)
}

func sortedManifestKeys(object map[string]any) []string {
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// loadPluginDir reads and validates the plugin in dir (named slug) and hashes its
// files. A manifest that doesn't validate, or a declared block without its directory,
// is reported in Err; ContentHash is set whenever the files could be read.
func loadPluginDir(slug, dir string) DiscoveredPlugin {
	plugin := DiscoveredPlugin{Slug: slug, Path: dir}
	hash, err := pluginContentHash(dir)
	if err != nil {
		plugin.Err = fmt.Errorf("hash plugin files: %w", err)
		return plugin
	}
	plugin.ContentHash = hash

	raw, err := readPluginManifest(filepath.Join(dir, pluginManifestFile))
	if err != nil {
		plugin.Err = err
		return plugin
	}
	manifest, normalized, err := ParsePluginManifest(raw, slug)
	if err != nil {
		plugin.Err = err
		return plugin
	}
	for i, block := range manifest.Blocks {
		info, err := os.Stat(filepath.Join(dir, "blocks", block))
		if err != nil || !info.IsDir() {
			plugin.Err = manifestProblem(fmt.Sprintf("blocks[%d]", i), "has no directory blocks/%s", block)
			return plugin
		}
	}
	// Blocks (#456): only for a plugin_api core implements, as the web build reads them
	// (lib/plugins/blocks.ts); another contract's block.json may be in a format this build
	// doesn't know, and that plugin is incompatible anyway.
	if pluginAPICompatible(manifest.PluginAPI) {
		specs, err := loadPluginBlocks(slug, dir, manifest.Blocks)
		if err != nil {
			plugin.Err = err
			return plugin
		}
		plugin.BlockSpecs = specs
	}
	plugin.Manifest = manifest
	plugin.ManifestJSON = normalized
	return plugin
}

func readPluginManifest(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, pluginManifestMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > pluginManifestMaxBytes {
		return nil, manifestProblem("", "is larger than %d bytes", pluginManifestMaxBytes)
	}
	return raw, nil
}

// pluginContentHash is the SHA-256 over a plugin's files (000054's content_hash): for
// every regular file, in byte order of its slash-separated path relative to dir, the
// line "<path>\x00<hex sha256 of the file>\n". Directories only count through their
// files, and symlinks and other non-regular entries aren't part of a package, so they
// are skipped. Line endings are hashed as stored, so a checkout that converts them
// hashes differently.
func pluginContentHash(dir string) (string, error) {
	type entry struct{ path, sum string }
	var entries []entry
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.Type().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		sum, err := fileSHA256(path)
		if err != nil {
			return err
		}
		entries = append(entries, entry{path: filepath.ToSlash(rel), sum: sum})
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].path < entries[j].path })
	hash := sha256.New()
	for _, e := range entries {
		fmt.Fprintf(hash, "%s\x00%s\n", e.path, e.sum)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

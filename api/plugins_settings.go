package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Plugin settings (#457, docs/design/plugin-system.md sections 4.4 and 6): the
// settings panel on the Plugins page. Admin only, like everything about a plugin but
// the enabled list.
//
//   - Rows live in extension_settings: key plugin:<slug>:<name>, extension_type
//     'plugin', extension_id <slug>. The public /extension-settings routes never serve
//     them (#451).
//   - The fields are the manifest's `settings`; a value is checked with the theme
//     block attr rules (themeAttrProblem, Block Spec attrProblem), the same ones the
//     manifest's default passed.
//   - A "secret": true field is write-only: GET answers {"set": true|false}, never
//     the value. Stored in the clear for Beta (backups contain it).
//   - DELETE (the page's "Delete plugin data") removes this plugin's rows and no
//     others. No state of a plugin touches content (section 4.4).

// pluginSettingStringMax caps a string setting that declares no maxLength (the
// manifest's own cap for maxLength).
const pluginSettingStringMax = pluginSettingLengthMax

// pluginSettingKey is a setting's extension_settings key.
func pluginSettingKey(slug, name string) string {
	return "plugin:" + slug + ":" + name
}

// PluginSettingField is one field of the form: the manifest's spec and its name.
type PluginSettingField struct {
	Name string `json:"name"`
	PluginSettingSpec
}

// PluginSettingsResponse is GET (and PUT's answer) /plugins/:slug/settings. Values
// holds what is stored and still valid; a field missing from it uses its default. A
// secret field is always there, as {"set": bool}.
type PluginSettingsResponse struct {
	Fields []PluginSettingField `json:"fields"`
	Values map[string]any       `json:"values"`
}

// PluginSecretState is a secret field's value as GET shows it.
type PluginSecretState struct {
	Set bool `json:"set"`
}

// UpdatePluginSettingsRequest is PUT /plugins/:slug/settings. Values names the fields
// to change: a value sets it, null clears it (the default applies again). Fields not
// named are kept, which is how the form leaves a secret alone.
type UpdatePluginSettingsRequest struct {
	Values map[string]json.RawMessage `json:"values" binding:"required"`
}

func pluginSettingsFields(manifest PluginManifest) []PluginSettingField {
	fields := make([]PluginSettingField, 0, len(manifest.Settings))
	for name, spec := range manifest.Settings {
		fields = append(fields, PluginSettingField{Name: name, PluginSettingSpec: spec})
	}
	sort.Slice(fields, func(i, j int) bool { return fields[i].Name < fields[j].Name })
	return fields
}

// pluginSettingProblem is "" when value (decoded JSON) is valid for spec.
func pluginSettingProblem(spec PluginSettingSpec, value any) string {
	if problem := themeAttrProblem(spec.ThemeAttrSpec, value); problem != "" {
		return problem
	}
	if s, ok := value.(string); ok && spec.MaxLength == nil && utf8.RuneCountInString(s) > pluginSettingStringMax {
		return fmt.Sprintf("must be at most %d characters", pluginSettingStringMax)
	}
	return ""
}

// storedPluginSettings reads a plugin's rows as name → value, keeping only declared
// fields whose stored value the manifest still accepts (an upgrade can narrow a
// field; such a value reads as unset, like a block attr that no longer validates).
// present names every declared field that has a row, valid or not.
func (server *Server) storedPluginSettings(c *gin.Context, plugin db.Plugin, manifest PluginManifest) (stored map[string]json.RawMessage, present map[string]bool, err error) {
	rows, err := server.store.ListPluginSettings(c.Request.Context(), plugin.Slug)
	if err != nil {
		return nil, nil, err
	}
	prefix := pluginSettingKey(plugin.Slug, "")
	stored, present = map[string]json.RawMessage{}, map[string]bool{}
	for _, row := range rows {
		name, ok := strings.CutPrefix(row.Key, prefix)
		if !ok {
			continue
		}
		spec, declared := manifest.Settings[name]
		if !declared {
			continue
		}
		present[name] = true
		var value any
		if json.Unmarshal(row.Value, &value) != nil || pluginSettingProblem(spec, value) != "" {
			continue
		}
		stored[name] = row.Value
	}
	return stored, present, nil
}

func toPluginSettingsResponse(manifest PluginManifest, stored map[string]json.RawMessage) PluginSettingsResponse {
	rsp := PluginSettingsResponse{Fields: pluginSettingsFields(manifest), Values: map[string]any{}}
	for _, field := range rsp.Fields {
		raw, set := stored[field.Name]
		switch {
		case field.Secret:
			rsp.Values[field.Name] = PluginSecretState{Set: set}
		case set:
			rsp.Values[field.Name] = raw
		}
	}
	return rsp
}

// loadPluginWithManifest is loadPlugin plus the stored manifest, decoded.
func (server *Server) loadPluginWithManifest(c *gin.Context) (db.Plugin, PluginManifest, bool) {
	plugin, ok := server.loadPlugin(c)
	if !ok {
		return db.Plugin{}, PluginManifest{}, false
	}
	var manifest PluginManifest
	if err := json.Unmarshal(plugin.Manifest, &manifest); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read the plugin's manifest"})
		return db.Plugin{}, PluginManifest{}, false
	}
	return plugin, manifest, true
}

// getPluginSettings is GET /plugins/:slug/settings (admin), in any status: a missing
// or disabled plugin keeps its settings (section 4.4).
func (server *Server) getPluginSettings(c *gin.Context) {
	plugin, manifest, ok := server.loadPluginWithManifest(c)
	if !ok {
		return
	}
	stored, _, err := server.storedPluginSettings(c, plugin, manifest)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load the plugin's settings"})
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, toPluginSettingsResponse(manifest, stored))
}

// updatePluginSettings is PUT /plugins/:slug/settings (admin). Only an installed
// plugin is configured: its manifest is the one in this build (409 plugin_missing or
// plugin_incompatible otherwise). Every value is checked before anything is written,
// and the writes are one transaction. Records plugin_settings_updated with the names
// of the fields that changed, never the values.
func (server *Server) updatePluginSettings(c *gin.Context) {
	plugin, manifest, ok := server.loadPluginWithManifest(c)
	if !ok {
		return
	}
	var req UpdatePluginSettingsRequest
	if !bindJSON(c, &req) {
		return
	}
	if plugin.Status != PluginStatusInstalled {
		respondPluginNotConfigurable(c, plugin)
		return
	}

	problems := map[string]string{}
	values := map[string]any{}
	for name, raw := range req.Values {
		spec, declared := manifest.Settings[name]
		if !declared {
			problems[name] = "is not a setting of this plugin"
			continue
		}
		var value any
		if err := json.Unmarshal(raw, &value); err != nil {
			problems[name] = "is not valid JSON"
			continue
		}
		if value == nil {
			values[name] = nil
			continue
		}
		if problem := pluginSettingProblem(spec, value); problem != "" {
			problems[name] = problem
			continue
		}
		values[name] = value
	}
	if len(problems) > 0 {
		names := make([]string, 0, len(problems))
		for name := range problems {
			names = append(names, name)
		}
		sort.Strings(names)
		c.JSON(http.StatusBadRequest, gin.H{
			"error":  fmt.Sprintf("%s %s", names[0], problems[names[0]]),
			"code":   "invalid_plugin_settings",
			"fields": problems,
		})
		return
	}

	stored, present, err := server.storedPluginSettings(c, plugin, manifest)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load the plugin's settings"})
		return
	}

	params := db.SetPluginSettingsTxParams{Slug: plugin.Slug}
	var changed []string
	for name, value := range values {
		key := pluginSettingKey(plugin.Slug, name)
		previous, had := stored[name]
		if value == nil {
			// A row the manifest no longer accepts is removed too, but it read as
			// unset already, so only clearing a valid value is a change.
			if present[name] {
				params.Clear = append(params.Clear, key)
			}
			if had {
				changed = append(changed, name)
			}
			continue
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save the plugin's settings"})
			return
		}
		if had && sameSettingValue(previous, value) {
			continue
		}
		params.Set = append(params.Set, db.PluginSettingWrite{Key: key, Value: encoded})
		changed = append(changed, name)
	}
	// Writes in key order, so two saves lock rows in the same order.
	sort.Slice(params.Set, func(i, j int) bool { return params.Set[i].Key < params.Set[j].Key })
	sort.Strings(params.Clear)

	if len(params.Set) > 0 || len(params.Clear) > 0 {
		if err := server.store.SetPluginSettingsTx(c.Request.Context(), params); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save the plugin's settings"})
			return
		}
	}
	if len(changed) > 0 {
		sort.Strings(changed)
		server.recordRequestActivity(c, activityEvent{
			Verb: db.ActivityPluginSettingsUpdated, ObjectType: db.ActivityObjectPlugin, ObjectID: plugin.ID,
			Payload: settingsActivityPayload(changed),
		})
	}

	stored, _, err = server.storedPluginSettings(c, plugin, manifest)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "saved, but failed to read the settings back"})
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, toPluginSettingsResponse(manifest, stored))
}

// deletePluginSettings is DELETE /plugins/:slug/settings (admin), the Plugins page's
// "Delete plugin data": every extension_settings row of this plugin and no other, in
// any status (a missing plugin's data is what an admin is most likely to clear).
// Blocks in posts are never touched (section 4.4).
func (server *Server) deletePluginSettings(c *gin.Context) {
	plugin, ok := server.loadPlugin(c)
	if !ok {
		return
	}
	deleted, err := server.store.DeletePluginSettings(c.Request.Context(), plugin.Slug)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete the plugin's data"})
		return
	}
	if deleted > 0 {
		server.recordRequestActivity(c, activityEvent{
			Verb: db.ActivityPluginDataDeleted, ObjectType: db.ActivityObjectPlugin, ObjectID: plugin.ID,
			Payload: map[string]any{"count": deleted},
		})
	}
	c.JSON(http.StatusOK, gin.H{"deleted": deleted})
}

func respondPluginNotConfigurable(c *gin.Context, plugin db.Plugin) {
	code, message := "plugin_incompatible", "the plugin is not compatible with this version of GoLive"
	if plugin.Status == PluginStatusMissing {
		code, message = "plugin_missing", "the plugin is not in this build"
	}
	c.JSON(http.StatusConflict, gin.H{"error": message, "code": code})
}

// settingsActivityFieldsBudget keeps plugin_settings_updated's payload inside the
// activity table's 1 KiB CHECK: a manifest allows 50 names of up to 64 characters.
const settingsActivityFieldsBudget = 900

// settingsActivityPayload is {"fields": names}, or, when the names wouldn't fit the
// activity payload, the ones that do (sorted) plus {"more": how many were left out}.
func settingsActivityPayload(names []string) map[string]any {
	kept, size := []string{}, 0
	for i, name := range names {
		// A name costs its length plus quotes and a comma.
		if size+len(name)+3 > settingsActivityFieldsBudget {
			return map[string]any{"fields": kept, "more": len(names) - i}
		}
		kept = append(kept, name)
		size += len(name) + 3
	}
	return map[string]any{"fields": kept}
}

// sameSettingValue reports whether a stored value equals a new one. Values are JSON
// scalars (string, float64, bool), so the decoded values compare with ==.
func sameSettingValue(stored json.RawMessage, value any) bool {
	var previous any
	return json.Unmarshal(stored, &previous) == nil && previous == value
}

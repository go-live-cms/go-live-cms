package db

import (
	"context"
	"encoding/json"
)

// PluginSettingWrite is one value SetPluginSettingsTx stores, under its full
// plugin:<slug>:<name> key.
type PluginSettingWrite struct {
	Key   string
	Value json.RawMessage
}

type SetPluginSettingsTxParams struct {
	// Slug is the plugin's (extension_id).
	Slug string
	Set  []PluginSettingWrite
	// Clear lists keys whose rows go, so the manifest's default applies again.
	Clear []string
}

// SetPluginSettingsTx applies one PUT /plugins/:slug/settings (#457): every
// write and removal, or none. The caller has validated the values against the
// manifest; this only writes rows of type plugin under Slug.
func (store *SQLStore) SetPluginSettingsTx(ctx context.Context, arg SetPluginSettingsTxParams) error {
	return store.execTx(ctx, func(q *Queries) error {
		for _, write := range arg.Set {
			if _, err := q.UpsertExtensionSetting(ctx, UpsertExtensionSettingParams{
				Key:           write.Key,
				Value:         write.Value,
				ExtensionType: "plugin",
				ExtensionID:   arg.Slug,
			}); err != nil {
				return err
			}
		}
		for _, key := range arg.Clear {
			if _, err := q.DeletePluginSetting(ctx, DeletePluginSettingParams{Key: key, ExtensionID: arg.Slug}); err != nil {
				return err
			}
		}
		return nil
	})
}

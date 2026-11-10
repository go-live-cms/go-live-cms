package db

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/go-live-cms/go-live-cms/util"
)

// The migration that namespaces stored theme settings (#451), run against rows
// in the old shapes. CI's up/down/up runs it on an empty table, which proves
// nothing about the renames. It runs in a transaction that is rolled back.
func TestThemeSettingKeysMigration(t *testing.T) {
	config, err := util.LoadConfig("../..")
	require.NoError(t, err)
	conn, err := sql.Open(config.DBDriver, config.DBSource)
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })
	tx, err := conn.Begin()
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback() })

	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	paper, atlas := "paper"+suffix, "atlas"+suffix
	contested, logo, label := "contested"+suffix, "logo"+suffix, "label"+suffix

	rows := []struct{ key, value, extensionType, extensionID string }{
		{paper + ":" + contested, `"readable"`, "theme", paper},
		{contested, `"bare"`, "theme", paper},
		{logo, `"bare logo"`, "theme", atlas},
		{"theme:" + label, `"slug is theme"`, "theme", "theme"},
		{"plugin:" + paper + ":api_key", `"secret"`, "plugin", paper},
		{"odd" + suffix, `1`, "theme", "a:b" + suffix},
	}
	for _, row := range rows {
		_, err := tx.Exec(`INSERT INTO extension_settings (key, value, extension_type, extension_id) VALUES ($1, $2, $3, $4)`,
			row.key, row.value, row.extensionType, row.extensionID)
		require.NoError(t, err)
	}

	valueOf := func(key string) string {
		t.Helper()
		var value string
		require.NoError(t, tx.QueryRow(`SELECT value::text FROM extension_settings WHERE key = $1`, key).Scan(&value), key)
		return value
	}
	apply := func(direction string) {
		t.Helper()
		paths, err := filepath.Glob("../migration/*_theme_extension_setting_keys." + direction + ".sql")
		require.NoError(t, err)
		require.Len(t, paths, 1)
		statements, err := os.ReadFile(paths[0])
		require.NoError(t, err)
		_, err = tx.Exec(string(statements))
		require.NoError(t, err)
	}

	apply("up")
	require.Equal(t, `"readable"`, valueOf("theme:"+paper+":"+contested), "the shape the old get read wins")
	require.Equal(t, `"bare"`, valueOf(contested), "a bare row whose new key is taken stays")
	require.Equal(t, `"bare logo"`, valueOf("theme:"+atlas+":"+logo))
	require.Equal(t, `"slug is theme"`, valueOf("theme:theme:"+label))
	require.Equal(t, `"secret"`, valueOf("plugin:"+paper+":api_key"), "a plugin's row isn't touched")
	require.Equal(t, `1`, valueOf("odd"+suffix), "a slug with a colon isn't touched")

	apply("down")
	require.Equal(t, `"readable"`, valueOf(paper+":"+contested))
	require.Equal(t, `"bare logo"`, valueOf(atlas+":"+logo))
	require.Equal(t, `"slug is theme"`, valueOf("theme:"+label))
	require.Equal(t, `"secret"`, valueOf("plugin:"+paper+":api_key"))
}

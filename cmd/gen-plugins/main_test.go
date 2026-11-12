package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(content), 0o644))
}

func fakeRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "go.mod"), "module example.test/cms\n\ngo 1.24\n")
	require.NoError(t, os.MkdirAll(filepath.Join(root, "api"), 0o755))
	return root
}

func TestGenerateWithoutServerPlugins(t *testing.T) {
	root := fakeRepo(t)
	// A plugin without server code, and one whose server/ only has a test.
	writeFile(t, filepath.Join(root, "web/plugins/blocks-only/plugin.json"), "{}")
	writeFile(t, filepath.Join(root, "web/plugins/tests-only/server/hooks_test.go"), "package server")

	out, err := generate(root)
	require.NoError(t, err)
	require.Contains(t, string(out), "package api")
	require.Contains(t, string(out), "No plugin in web/plugins has server code.")
	require.NotContains(t, string(out), "import (")
}

func TestGenerateImportsSortedServerPackages(t *testing.T) {
	root := fakeRepo(t)
	writeFile(t, filepath.Join(root, "web/plugins/zeta/server/hooks.go"), "package server")
	writeFile(t, filepath.Join(root, "web/plugins/reading-time/server/hooks.go"), "package server")
	writeFile(t, filepath.Join(root, "web/plugins/no-server/plugin.json"), "{}")

	out, err := generate(root)
	require.NoError(t, err)
	text := string(out)
	first := strings.Index(text, `_ "example.test/cms/web/plugins/reading-time/server"`)
	second := strings.Index(text, `_ "example.test/cms/web/plugins/zeta/server"`)
	require.True(t, first > 0 && second > first, text)
	require.NotContains(t, text, "no-server")
	require.True(t, strings.HasPrefix(text, "// Code generated"), "go vet and linters skip generated files by this header")
}

func TestGenerateRefusesABadSlug(t *testing.T) {
	root := fakeRepo(t)
	writeFile(t, filepath.Join(root, "web/plugins/Bad_Name/server/hooks.go"), "package server")
	_, err := generate(root)
	require.ErrorContains(t, err, "not a plugin id")
}

func TestRunWritesThenChecks(t *testing.T) {
	root := fakeRepo(t)
	writeFile(t, filepath.Join(root, "web/plugins/seo/server/hooks.go"), "package server")

	require.ErrorContains(t, run(root, true), "out of date", "no file yet")
	require.NoError(t, run(root, false))
	require.NoError(t, run(root, true))

	writeFile(t, filepath.Join(root, "web/plugins/new-one/server/hooks.go"), "package server")
	require.ErrorContains(t, run(root, true), "out of date")
}

func TestModulePath(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "go.mod"), "// comment\nmodule \"example.test/x\"\n")
	module, err := modulePath(filepath.Join(root, "go.mod"))
	require.NoError(t, err)
	require.Equal(t, "example.test/x", module)

	writeFile(t, filepath.Join(root, "go.mod"), "go 1.24\n")
	_, err = modulePath(filepath.Join(root, "go.mod"))
	require.Error(t, err)
}

// The committed api/plugins_gen.go matches web/plugins (what CI's --check enforces).
func TestCommittedFileIsCurrent(t *testing.T) {
	require.NoError(t, run(filepath.Join("..", ".."), true))
}

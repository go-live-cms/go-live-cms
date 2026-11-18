//go:build ignore

// sync_starters copies the default theme's block templates and parts into starters/ (#498, design
// docs/design/theme-builder.md 5.7): core's starters are the default theme's own files, embedded so
// the API has them without web/themes. Run from api/sitedesign with `go generate`;
// TestStartersAreTheDefaultThemes fails while the copies differ.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const themeDir = "../../web/themes/default"

func main() {
	for _, dir := range []string{"templates", "parts"} {
		old, _ := filepath.Glob(filepath.Join("starters", dir, "*.json"))
		for _, path := range old {
			if err := os.Remove(path); err != nil {
				fail(err)
			}
		}
		files, err := filepath.Glob(filepath.Join(themeDir, dir, "*.json"))
		if err != nil {
			fail(err)
		}
		if err := os.MkdirAll(filepath.Join("starters", dir), 0o755); err != nil {
			fail(err)
		}
		for _, path := range files {
			raw, err := os.ReadFile(path)
			if err != nil {
				fail(err)
			}
			if err := os.WriteFile(filepath.Join("starters", dir, filepath.Base(path)), raw, 0o644); err != nil {
				fail(err)
			}
		}
		fmt.Printf("%s: %d files (%s)\n", dir, len(files), strings.Join(names(files), ", "))
	}
}

func names(paths []string) []string {
	out := make([]string, len(paths))
	for i, path := range paths {
		out[i] = strings.TrimSuffix(filepath.Base(path), ".json")
	}
	return out
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

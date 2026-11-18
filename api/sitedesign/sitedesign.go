// Package sitedesign holds what the theme builder's templates and parts start from
// (#490, docs/design/theme-builder.md 5.7): the file format a theme ships them in
// (templates/<slug>.json, parts/<slug>.json) and core's starters, embedded in the binary: since
// #498 the default theme's own templates and parts (sync_starters.go copies them; `go generate`).
//
// It knows nothing about the database or the Block Spec's rules: the api package
// validates a doc (prepareForStoreAs, the kind's rules) before anything stores it.
package sitedesign

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Kinds of site_templates rows: a block template or a template part.
const (
	KindTemplate = "template"
	KindPart     = "part"
)

// MaxTitleRunes is site_templates.title's varchar(120).
const MaxTitleRunes = 120

// MaxFileBytes caps one shipped or starter file: a template is a page's frame, not its
// content, so this is generous.
const MaxFileBytes = 1 << 20

// SlugPattern is site_templates.slug's CHECK: '_' because post type and taxonomy names
// allow it (single-case_study), 80 so custom-<name> fits a 64-character name.
var SlugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,79}$`)

// File is one template or part as a theme ships it: `{ "title": "Header", "doc": {…} }`,
// the doc a Block Spec v1 document.
type File struct {
	Title string          `json:"title"`
	Doc   json.RawMessage `json:"doc"`
}

// ParseFile decodes a shipped or starter file strictly: no unknown fields, no trailing
// data, a one-line title of at most MaxTitleRunes, and a doc that is a JSON object with
// a blocks_order array and a blocks object. Deeper rules are the caller's.
func ParseFile(raw []byte) (File, error) {
	var file File
	if len(raw) > MaxFileBytes {
		return file, fmt.Errorf("file is larger than %d bytes", MaxFileBytes)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&file); err != nil {
		return file, fmt.Errorf("not a template file: %w", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return file, errors.New("not a template file: trailing data")
	}
	title := strings.TrimSpace(file.Title)
	switch {
	case title == "":
		return file, errors.New("title is required")
	case utf8.RuneCountInString(title) > MaxTitleRunes:
		return file, fmt.Errorf("title is longer than %d characters", MaxTitleRunes)
	case strings.ContainsAny(title, "\r\n"):
		return file, errors.New("title must be one line")
	}
	file.Title = title
	var shape struct {
		BlocksOrder []json.RawMessage          `json:"blocks_order"`
		Blocks      map[string]json.RawMessage `json:"blocks"`
	}
	if len(bytes.TrimSpace(file.Doc)) == 0 || bytes.TrimSpace(file.Doc)[0] != '{' {
		return file, errors.New("doc must be a Block Spec v1 document")
	}
	if err := json.Unmarshal(file.Doc, &shape); err != nil || shape.BlocksOrder == nil || shape.Blocks == nil {
		return file, errors.New("doc must be a Block Spec v1 document")
	}
	return file, nil
}

// Hash is the content hash stored with a shipped template (the theme's config) and
// copied into site_templates.source_hash when an admin customizes it, so the Site
// editor can say "Default changed since you customized" (design section 9). It hashes
// the doc as given: callers pass the normalized doc they store.
func Hash(doc []byte) string {
	sum := sha256.Sum256(doc)
	return hex.EncodeToString(sum[:])
}

//go:generate go run sync_starters.go

// starters are the default theme's templates/ and parts/ (#498), copied here by sync_starters.go so
// the API has them without web/themes; TestStartersAreTheDefaultThemes keeps them equal.
//
//go:embed starters/templates/*.json starters/parts/*.json
var starters embed.FS

// Starter is core's starter for a slug (design 5.7): "Customize" on a slug whose
// default is a code layout starts from it. A part has a starter only for its own slug
// (header, footer). A template takes the starter of its slug, else of each shorter
// dash-separated prefix (single-case_study → single), else core's generic one (index),
// so every template slug has one. ok is false for a part without one, or a slug that
// isn't a slug.
//
// The starters are the default theme's own templates and parts (#498, design 5.7, which
// replaced core's interim ones of #491): one per route kind of design 3.2 (single and its
// sidebar and wide variants, page and page-fullwidth, archive, taxonomy, author, home,
// search, 404) and the header and footer, so "Customize" on any other code theme starts from
// what the default theme's readers see. The slugs that share a shape take another's
// (starterAliases); a slug with nothing closer starts from the archive (fallbackStarter).
func Starter(kind, slug string) (File, bool) {
	if !SlugPattern.MatchString(slug) {
		return File{}, false
	}
	switch kind {
	case KindPart:
		return readStarter("starters/parts/" + slug + ".json")
	case KindTemplate:
		for candidate := slug; candidate != ""; {
			if file, ok := readStarter("starters/templates/" + candidate + ".json"); ok {
				return file, true
			}
			if alias, ok := starterAliases[candidate]; ok {
				if file, ok := readStarter("starters/templates/" + alias + ".json"); ok {
					return file, true
				}
			}
			cut := strings.LastIndex(candidate, "-")
			if cut <= 0 {
				break
			}
			candidate = candidate[:cut]
		}
		return readStarter("starters/templates/" + fallbackStarter + ".json")
	}
	return File{}, false
}

// fallbackStarter is the template a slug that matches nothing closer starts from: a list of
// the site's posts, with the header and footer.
const fallbackStarter = "archive"

// starterAliases names the starter a slug (or slug prefix) without its own file starts
// from: a builder page template (custom-<name>, design 10) is a page, and the front page
// lists the latest posts like home (as a page, it customizes `page` or `page-<template>`
// instead). The default theme ships `author` and `taxonomy` (#498), so those need none.
var starterAliases = map[string]string{
	"custom": "page",
	"front":  "home",
}

func readStarter(name string) (File, bool) {
	raw, err := starters.ReadFile(name)
	if err != nil {
		return File{}, false
	}
	file, err := ParseFile(raw)
	if err != nil {
		// The embedded files are tested (TestStartersAreValid); a bad one is a build bug,
		// so it's logged rather than passed off as "no starter".
		slog.Error("site_design_starter_invalid", "starter", name, "error", err)
		return File{}, false
	}
	return file, true
}

// StarterNames lists every embedded starter as "<kind>/<slug>", for tests.
func StarterNames() []string {
	var names []string
	for _, dir := range []struct{ kind, path string }{{KindTemplate, "starters/templates"}, {KindPart, "starters/parts"}} {
		entries, _ := starters.ReadDir(dir.path)
		for _, entry := range entries {
			names = append(names, dir.kind+"/"+strings.TrimSuffix(entry.Name(), ".json"))
		}
	}
	return names
}

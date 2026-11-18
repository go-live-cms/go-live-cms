package api

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// The state rule and the text rules (#522) against the vectors the web's twin runs
// (web/src/lib/discussion.test.ts).

const (
	discussionStateVectorsPath = "../web/src/lib/discussionStateVectors.json"
	discussionTextVectorsPath  = "../web/src/lib/discussionTextVectors.json"
)

type discussionStateCase struct {
	Name string `json:"name"`
	Site struct {
		Enabled        bool  `json:"comments_enabled"`
		CloseAfterDays int32 `json:"comments_close_after_days"`
	} `json:"site"`
	Type struct {
		Public   bool     `json:"public"`
		Supports []string `json:"supports"`
	} `json:"type"`
	Post struct {
		Discussion       string     `json:"discussion"`
		FirstPublishedAt *time.Time `json:"first_published_at"`
	} `json:"post"`
	Now     time.Time         `json:"now"`
	Setting DiscussionSetting `json:"setting"`
	State   string            `json:"state"`
}

func readJSONVectors(t *testing.T, path string, into any) {
	t.Helper()
	data, err := os.ReadFile(path)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(data, into))
}

func TestDiscussionStateVectors(t *testing.T) {
	var vectors struct {
		Cases []discussionStateCase `json:"cases"`
	}
	readJSONVectors(t, discussionStateVectorsPath, &vectors)
	require.Greater(t, len(vectors.Cases), 10)

	overridesTimer := false
	for _, c := range vectors.Cases {
		t.Run(c.Name, func(t *testing.T) {
			setting := discussionSetting(
				discussionSite{Enabled: c.Site.Enabled, CloseAfterDays: c.Site.CloseAfterDays},
				discussionType{Public: c.Type.Public, Supports: c.Type.Supports},
				discussionPost{Discussion: c.Post.Discussion, FirstPublishedAt: c.Post.FirstPublishedAt},
			)
			require.Equal(t, c.Setting.State, setting.State)
			if c.Setting.ClosesAt == nil {
				require.Nil(t, setting.ClosesAt)
			} else {
				require.NotNil(t, setting.ClosesAt)
				require.True(t, c.Setting.ClosesAt.Equal(*setting.ClosesAt), "closes_at %s, want %s", setting.ClosesAt, c.Setting.ClosesAt)
				require.Equal(t, time.UTC, setting.ClosesAt.Location(), "closes_at is UTC")
			}
			require.Equal(t, c.State, discussionState(setting, c.Now))
		})
		if c.Post.Discussion == postDiscussionOpen && c.Site.CloseAfterDays > 0 && c.State == discussionStateOpen {
			overridesTimer = true
		}
	}
	require.True(t, overridesTimer, "the vectors pin an explicit Open overriding the timer")
}

type discussionTextRepeat struct {
	Text  string `json:"text"`
	Times int    `json:"times"`
}

type discussionTextCase struct {
	Name             string                `json:"name"`
	Input            string                `json:"input"`
	Repeat           *discussionTextRepeat `json:"repeat"`
	Normalized       *string               `json:"normalized"`
	NormalizedRepeat *discussionTextRepeat `json:"normalized_repeat"`
	Code             string                `json:"code"`
}

func (c discussionTextCase) input() string {
	if c.Repeat != nil {
		return strings.Repeat(c.Repeat.Text, c.Repeat.Times)
	}
	return c.Input
}

func (c discussionTextCase) normalized() string {
	if c.NormalizedRepeat != nil {
		return strings.Repeat(c.NormalizedRepeat.Text, c.NormalizedRepeat.Times)
	}
	if c.Normalized != nil {
		return *c.Normalized
	}
	return ""
}

func TestDiscussionTextVectors(t *testing.T) {
	var vectors struct {
		Limits map[string]int       `json:"limits"`
		Body   []discussionTextCase `json:"body"`
		Name   []discussionTextCase `json:"name"`
	}
	readJSONVectors(t, discussionTextVectorsPath, &vectors)
	require.Equal(t, map[string]int{
		"body_min":        readerCommentBodyMin,
		"body_max":        readerCommentBodyMax,
		"max_blank_lines": readerCommentMaxBlankLines,
		"name_max":        readerCommentNameMax,
	}, vectors.Limits)

	run := func(kind string, cases []discussionTextCase, normalize func(string) (string, string)) {
		require.NotEmpty(t, cases, kind)
		for _, c := range cases {
			t.Run(kind+": "+c.Name, func(t *testing.T) {
				got, code := normalize(c.input())
				if c.Code != "" {
					require.Equal(t, c.Code, code)
					require.Empty(t, got)
					return
				}
				require.Empty(t, code)
				require.Equal(t, c.normalized(), got)
			})
		}
	}
	run("body", vectors.Body, normalizeReaderCommentBody)
	run("name", vectors.Name, normalizeReaderCommentName)
}

// The network hash (7.2) is keyed, stable for one network (an IPv6 /64), different
// across networks and keys, and never contains the address.
func TestDiscussionNetworkHash(t *testing.T) {
	key := strings.Repeat("ab", 32)
	other := strings.Repeat("cd", 32)

	a, err := discussionNetworkHash(key, "203.0.113.7")
	require.NoError(t, err)
	require.Len(t, a, 32)
	again, err := discussionNetworkHash(key, "203.0.113.7")
	require.NoError(t, err)
	require.Equal(t, a, again)

	b, err := discussionNetworkHash(key, "203.0.113.8")
	require.NoError(t, err)
	require.NotEqual(t, a, b, "another address, another hash")

	rotated, err := discussionNetworkHash(other, "203.0.113.7")
	require.NoError(t, err)
	require.NotEqual(t, a, rotated, "another key, another hash")

	v6a, err := discussionNetworkHash(key, "2001:db8:1:2::1")
	require.NoError(t, err)
	v6b, err := discussionNetworkHash(key, "2001:db8:1:2:ffff::9")
	require.NoError(t, err)
	require.Equal(t, v6a, v6b, "one IPv6 /64 is one network")

	mapped, err := discussionNetworkHash(key, "::ffff:203.0.113.7")
	require.NoError(t, err)
	require.Equal(t, a, mapped, "an IPv4-mapped address is the IPv4 one")

	require.NotContains(t, string(a), "203.0.113.7")

	_, err = discussionNetworkHash("", "203.0.113.7")
	require.Error(t, err)
	_, err = discussionNetworkHash("not hex", "203.0.113.7")
	require.Error(t, err)
}

func TestNormalizeDiscussionWords(t *testing.T) {
	words, err := normalizeDiscussionWords("comments_hold_words", []string{"  casino ", "", "Casino", "free money", "   "})
	require.NoError(t, err)
	require.Equal(t, []string{"casino", "free money"}, words, "trimmed, blanks dropped, duplicates ignoring case once")

	words, err = normalizeDiscussionWords("comments_hold_words", []string{})
	require.NoError(t, err)
	require.NotNil(t, words, "[] clears the list")
	require.Empty(t, words)

	_, err = normalizeDiscussionWords("comments_spam_words", []string{strings.Repeat("x", discussionWordMax+1)})
	require.ErrorContains(t, err, "at most 64 characters")
	_, err = normalizeDiscussionWords("comments_spam_words", []string{"two\nlines"})
	require.ErrorContains(t, err, "one line")

	many := make([]string, discussionWordListMax+1)
	for i := range many {
		many[i] = "w" + strings.Repeat("x", i%60) + string(rune('a'+i%26)) + string(rune('a'+i/26%26))
	}
	_, err = normalizeDiscussionWords("comments_spam_words", many)
	require.ErrorContains(t, err, "at most 500 entries")
}

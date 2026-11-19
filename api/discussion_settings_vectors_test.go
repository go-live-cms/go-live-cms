package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/stretchr/testify/require"
)

// Settings › Discussion's checks (#527) against the vectors the admin's form runs
// (web/gl-admin/lib/discussionSettings.test.ts), so the form refuses exactly what
// PUT /settings refuses.

const discussionSettingsVectorsPath = "../web/gl-admin/lib/discussionSettingsVectors.json"

// discussionVectorString is a string given as is or as {"repeat": {text, times}}.
type discussionVectorString string

func (s *discussionVectorString) UnmarshalJSON(data []byte) error {
	var plain string
	if err := json.Unmarshal(data, &plain); err == nil {
		*s = discussionVectorString(plain)
		return nil
	}
	var repeat struct {
		Repeat *struct {
			Text  string `json:"text"`
			Times int    `json:"times"`
		} `json:"repeat"`
	}
	if err := json.Unmarshal(data, &repeat); err != nil || repeat.Repeat == nil {
		return fmt.Errorf("not a vector string: %s", data)
	}
	*s = discussionVectorString(strings.Repeat(repeat.Repeat.Text, repeat.Repeat.Times))
	return nil
}

// discussionVectorLines is a list of strings where an item may also be
// {"numbered": N}: the N lines word1 … wordN.
type discussionVectorLines []string

func (l *discussionVectorLines) UnmarshalJSON(data []byte) error {
	var items []json.RawMessage
	if err := json.Unmarshal(data, &items); err != nil {
		return err
	}
	out := []string{}
	for _, item := range items {
		var numbered struct {
			Numbered *int `json:"numbered"`
		}
		if json.Unmarshal(item, &numbered) == nil && numbered.Numbered != nil {
			for i := 1; i <= *numbered.Numbered; i++ {
				out = append(out, fmt.Sprintf("word%d", i))
			}
			continue
		}
		var s discussionVectorString
		if err := json.Unmarshal(item, &s); err != nil {
			return err
		}
		out = append(out, string(s))
	}
	*l = out
	return nil
}

type discussionSettingsVectors struct {
	Limits map[string]json.RawMessage `json:"limits"`
	Ranges []struct {
		Field string `json:"field"`
		Value int32  `json:"value"`
		OK    bool   `json:"ok"`
	} `json:"ranges"`
	Words []struct {
		Name       string                 `json:"name"`
		Input      discussionVectorLines  `json:"input"`
		Normalized *discussionVectorLines `json:"normalized"`
		Code       string                 `json:"code"`
	} `json:"words"`
	Notice []struct {
		Name       string                  `json:"name"`
		Input      discussionVectorString  `json:"input"`
		Normalized *discussionVectorString `json:"normalized"`
		Code       string                  `json:"code"`
	} `json:"notice"`
}

// discussionWordsCode maps normalizeDiscussionWords' messages to the vectors' codes.
func discussionWordsCode(t *testing.T, err error) string {
	t.Helper()
	var fieldErr discussionFieldError
	require.True(t, errors.As(err, &fieldErr), "a field error: %v", err)
	switch {
	case strings.Contains(fieldErr.message, "one line"):
		return "entry_invalid"
	case strings.Contains(fieldErr.message, "characters"):
		return "entry_too_long"
	case strings.Contains(fieldErr.message, "entries"):
		return "too_many"
	}
	t.Fatalf("unknown word list message %q", fieldErr.message)
	return ""
}

func TestDiscussionSettingsVectors(t *testing.T) {
	var vectors discussionSettingsVectors
	readJSONVectors(t, discussionSettingsVectorsPath, &vectors)

	t.Run("limits", func(t *testing.T) {
		limit := func(key string, into any) {
			require.NoError(t, json.Unmarshal(vectors.Limits[key], into), key)
		}
		var n int
		limit("word_list_max", &n)
		require.Equal(t, discussionWordListMax, n)
		limit("word_max", &n)
		require.Equal(t, discussionWordMax, n)
		limit("notice_max", &n)
		require.Equal(t, discussionNoticeMax, n)
	})

	require.NotEmpty(t, vectors.Ranges)
	for _, c := range vectors.Ranges {
		t.Run(fmt.Sprintf("%s=%d", c.Field, c.Value), func(t *testing.T) {
			v := c.Value
			var req discussionSettingsRequest
			switch c.Field {
			case "comments_max_links":
				req.CommentsMaxLinks = &v
			case "comments_close_after_days":
				req.CommentsCloseAfterDays = &v
			case "comments_per_page":
				req.CommentsPerPage = &v
			default:
				t.Fatalf("unknown field %s", c.Field)
			}
			_, err := req.apply(&db.UpdateSettingsParams{})
			require.Equal(t, c.OK, err == nil, "%v", err)
		})
	}

	require.NotEmpty(t, vectors.Words)
	for _, c := range vectors.Words {
		t.Run("words/"+c.Name, func(t *testing.T) {
			words, err := normalizeDiscussionWords("comments_hold_words", c.Input)
			if c.Normalized != nil {
				require.NoError(t, err)
				require.Equal(t, []string(*c.Normalized), words)
				return
			}
			require.Error(t, err)
			require.Equal(t, c.Code, discussionWordsCode(t, err))
		})
	}

	require.NotEmpty(t, vectors.Notice)
	for _, c := range vectors.Notice {
		t.Run("notice/"+c.Name, func(t *testing.T) {
			notice := string(c.Input)
			params := db.UpdateSettingsParams{}
			_, err := discussionSettingsRequest{CommentsNotice: &notice}.apply(&params)
			if c.Normalized != nil {
				require.NoError(t, err)
				require.Equal(t, string(*c.Normalized), params.CommentsNotice.String)
				return
			}
			require.Error(t, err)
			code := "not_one_line"
			if strings.Contains(err.Error(), "at most") {
				code = "too_long"
			}
			require.Equal(t, c.Code, code)
		})
	}
}

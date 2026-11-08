package api

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// #320's inline nodes on the Go side: the shared vectors (the web reads the same file),
// the sanitizer inside a block's pm, and what a collab store's doc yields for the
// mention ledger and the reminders.

func TestInlineNodeVectors(t *testing.T) {
	raw, err := os.ReadFile("../web/gl-admin/lib/blocks-spec/inlineNodeVectors.json")
	require.NoError(t, err)
	var file struct {
		Cases []struct {
			Name     string                 `json:"name"`
			Type     string                 `json:"type"`
			Attrs    map[string]interface{} `json:"attrs"`
			Expected map[string]interface{} `json:"expected"`
		} `json:"cases"`
	}
	require.NoError(t, json.Unmarshal(raw, &file))
	require.NotEmpty(t, file.Cases)
	for _, c := range file.Cases {
		t.Run(c.Name, func(t *testing.T) {
			got := sanitizeInlineNodeAttrs(c.Type, c.Attrs)
			if c.Expected == nil {
				require.Nil(t, got)
				return
			}
			require.Equal(t, c.Expected, got)
		})
	}
}

func TestNormalizeInlineLabelCapsCodePoints(t *testing.T) {
	long := strings.Repeat("á", 250)
	require.Equal(t, strings.Repeat("á", inlineLabelMaxRunes), normalizeInlineLabel(long))
	require.Equal(t, "Ana", normalizeInlineLabel(strings.Repeat(" ", 3)+"Ana"))
	require.Equal(t, "", normalizeInlineLabel(42))
}

func pmParagraph(content ...map[string]interface{}) map[string]interface{} {
	children := make([]interface{}, len(content))
	for i, c := range content {
		children[i] = c
	}
	return map[string]interface{}{"type": "paragraph", "content": children}
}

func TestSanitize_InlineNodesInPM(t *testing.T) {
	doc := BlockDocV1{
		DocVersion:  1,
		BlocksOrder: []string{"blk-inline-01"},
		Blocks: map[string]interface{}{
			"blk-inline-01": map[string]interface{}{
				"id": "blk-inline-01", "type": "paragraph", "version": 1.0,
				"attrs": map[string]interface{}{
					"pm": pmParagraph(
						map[string]interface{}{"type": "text", "text": "Ask "},
						// Kept, with only its attrs; marks stay.
						map[string]interface{}{"type": "mention", "attrs": map[string]interface{}{"userId": 7.0, "label": "Ana", "email": "ana@example.test", "onclick": "x"}, "marks": []interface{}{map[string]interface{}{"type": "bold"}}},
						// No id: its label as text.
						map[string]interface{}{"type": "mention", "attrs": map[string]interface{}{"label": "Kenji"}},
						// A stored href never survives: the URL is resolved at read time.
						map[string]interface{}{"type": "contentLink", "attrs": map[string]interface{}{"postId": 3.0, "label": "About", "href": "javascript:alert(1)"}},
						// No id and no label: dropped.
						map[string]interface{}{"type": "contentLink", "attrs": map[string]interface{}{}},
						// Not a day: dropped.
						map[string]interface{}{"type": "dateChip", "attrs": map[string]interface{}{"date": "2026-13-01"}},
						map[string]interface{}{"type": "dateChip", "attrs": map[string]interface{}{"date": "2026-11-12", "reminder": true}, "content": []interface{}{map[string]interface{}{"type": "text", "text": "smuggled"}}},
					),
				},
			},
		},
	}
	doc.sanitize()
	content := blockPM(doc.Blocks["blk-inline-01"])["content"].([]interface{})
	require.Len(t, content, 5)
	require.Equal(t, map[string]interface{}{"type": "mention", "attrs": map[string]interface{}{"userId": 7.0, "label": "Ana"}, "marks": []interface{}{map[string]interface{}{"type": "bold"}}}, content[1])
	require.Equal(t, map[string]interface{}{"type": "text", "text": "@Kenji"}, content[2])
	require.Equal(t, map[string]interface{}{"type": "contentLink", "attrs": map[string]interface{}{"postId": 3.0, "label": "About"}}, content[3])
	require.Equal(t, map[string]interface{}{"type": "dateChip", "attrs": map[string]interface{}{"date": "2026-11-12", "time": "09:00", "reminder": true}}, content[4])
}

// The bridge's own output passes through unchanged: a store never rewrites a valid doc.
func TestSanitize_InlineNodesBridgeOutputUnchanged(t *testing.T) {
	pm := pmParagraph(
		map[string]interface{}{"type": "mention", "attrs": map[string]interface{}{"userId": 7.0, "label": "Ana"}},
		map[string]interface{}{"type": "contentLink", "attrs": map[string]interface{}{"postId": 3.0, "label": nil}},
		map[string]interface{}{"type": "dateChip", "attrs": map[string]interface{}{"date": "2026-11-12", "time": nil, "reminder": false}},
	)
	before, err := json.Marshal(pm)
	require.NoError(t, err)
	sanitizePMNode(pm)
	after, err := json.Marshal(pm)
	require.NoError(t, err)
	require.JSONEq(t, string(before), string(after))
}

func inlineDoc(blocks map[string]map[string]interface{}) *BlockDocV1 {
	doc := &BlockDocV1{DocVersion: 1, Blocks: map[string]interface{}{}}
	for id, pm := range blocks {
		doc.BlocksOrder = append(doc.BlocksOrder, id)
		doc.Blocks[id] = map[string]interface{}{"id": id, "type": "paragraph", "version": 1.0, "attrs": map[string]interface{}{"pm": pm}}
	}
	return doc
}

func mentionNode(userID float64) map[string]interface{} {
	return map[string]interface{}{"type": "mention", "attrs": map[string]interface{}{"userId": userID, "label": "Someone"}}
}

func reminderNode(date, clock string) map[string]interface{} {
	return map[string]interface{}{"type": "dateChip", "attrs": map[string]interface{}{"date": date, "time": clock, "reminder": true}}
}

func TestCollabInlineNodes(t *testing.T) {
	lisbon, err := time.LoadLocation("Europe/Lisbon")
	require.NoError(t, err)
	doc := inlineDoc(map[string]map[string]interface{}{
		// A member is one entry however often they're mentioned; 8 is mentioned too.
		"blk-a0000001": pmParagraph(mentionNode(7), mentionNode(7), mentionNode(8)),
		// 7 again, and 9 in a block nobody changed in this store; 8 there too.
		"blk-b0000001": {"type": "blockquote", "content": []interface{}{pmParagraph(mentionNode(7), mentionNode(9), reminderNode("2026-12-01", "10:30"))}},
		"blk-0z000001": pmParagraph(mentionNode(8)),
		// A plain date isn't a reminder; a bad id isn't a mention.
		"blk-c0000001": pmParagraph(map[string]interface{}{"type": "dateChip", "attrs": map[string]interface{}{"date": "2026-12-02"}}, mentionNode(0)),
	})
	edits := []db.PostBlockEditInput{{BlockID: "blk-a0000001", UserID: 3}}

	mentions, reminders := collabInlineNodes(doc, edits, lisbon)
	require.Equal(t, []db.MentionInput{
		// 8 is first seen in blk-0z000001 (block ids in order), but the block this store
		// changed wins: who typed it is known there.
		{BlockID: "blk-a0000001", UserID: 8, MentionedBy: 3},
		{BlockID: "blk-a0000001", UserID: 7, MentionedBy: 3},
		// Nobody changed this block in the store: recorded, never emailed.
		{BlockID: "blk-b0000001", UserID: 9, MentionedBy: 0},
	}, mentions)
	require.Len(t, reminders, 1)
	// 10:30 in Lisbon on 2026-12-01 (WET, UTC+0) is 10:30 UTC.
	require.Equal(t, db.ReminderInput{BlockID: "blk-b0000001", RemindAt: time.Date(2026, 12, 1, 10, 30, 0, 0, time.UTC), ChipDate: "2026-12-01", ChipTime: "10:30", UserID: 0}, reminders[0])
	require.True(t, docHasReminders(doc))

	// Without the zone (no reminder needs it), no reminder is read.
	_, reminders = collabInlineNodes(doc, edits, nil)
	require.Empty(t, reminders)

	// A doc with none passes nil, so a store without them sends the params it always did.
	mentions, reminders = collabInlineNodes(inlineDoc(map[string]map[string]interface{}{"blk-p0000001": pmParagraph()}), nil, time.UTC)
	require.Nil(t, mentions)
	require.Nil(t, reminders)
	require.False(t, docHasReminders(inlineDoc(map[string]map[string]interface{}{"blk-p0000001": pmParagraph()})))
}

func TestReminderInstantInTheSiteZone(t *testing.T) {
	newYork, err := time.LoadLocation("America/New_York")
	require.NoError(t, err)
	at, ok := reminderInstant("2026-07-01", "09:00", newYork)
	require.True(t, ok)
	require.Equal(t, time.Date(2026, 7, 1, 13, 0, 0, 0, time.UTC), at)
	// 02:30 doesn't exist on 2026-03-08 there (spring forward): it fires at 03:00 EDT.
	at, ok = reminderInstant("2026-03-08", "02:30", newYork)
	require.True(t, ok)
	require.Equal(t, time.Date(2026, 3, 8, 7, 0, 0, 0, time.UTC), at)
	_, ok = reminderInstant("nope", "09:00", newYork)
	require.False(t, ok)
}

func TestMentionHelpers(t *testing.T) {
	require.Equal(t, "Post", mentionTypeLabel("post"))
	require.Equal(t, "Case Study", mentionTypeLabel("case_study"))
	ids, ok := parseMentionIDs("3, 1,3")
	require.True(t, ok)
	require.Equal(t, []int64{3, 1}, ids)
	_, ok = parseMentionIDs("1,x")
	require.False(t, ok)
	_, ok = parseMentionIDs("0")
	require.False(t, ok)
	distinct := make([]string, mentionLookupMax+1)
	for i := range distinct {
		distinct[i] = strconv.Itoa(i + 1)
	}
	_, ok = parseMentionIDs(strings.Join(distinct, ","))
	require.False(t, ok, "more than mentionLookupMax ids")
	_, ok = parseMentionIDs(strings.TrimSuffix(strings.Repeat("5,", mentionLookupMax+50), ","))
	require.True(t, ok, "repeats are deduped before the cap")
}

func TestPublicizeInlineNodesWithoutLookups(t *testing.T) {
	// A date chip needs no lookup: its reminder flag is dropped, its day kept.
	doc := map[string]interface{}{"blocks": map[string]interface{}{
		"blk-d0000001": map[string]interface{}{"attrs": map[string]interface{}{"pm": pmParagraph(reminderNode("2026-12-01", "10:30"))}},
	}}
	server := &Server{}
	server.publicizeInlineNodes(t.Context(), doc)
	node := blockPM(doc["blocks"].(map[string]interface{})["blk-d0000001"])["content"].([]interface{})[0].(map[string]interface{})
	require.Equal(t, map[string]interface{}{"date": "2026-12-01", "time": "10:30"}, node["attrs"])
}

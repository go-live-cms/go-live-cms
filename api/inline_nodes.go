package api

// Inline nodes (#320): an @ mention, a link to a post or page, and a date chip, inside a
// text block's pm. The rules are the web's (web/gl-admin/lib/blocks-spec/inlineNodes.ts);
// inlineNodeVectors.json there is shared with TestInlineNodeVectors.
//
//   - Stored (the sanitizer, every write of a block_doc): each node's attrs are an
//     allowlist, each value normalized. A mention or link without a valid id becomes its
//     label as plain text (the author's words stay), a date chip without a valid date is
//     dropped.
//   - Public (publicizeInlineNodes, every /public response that carries a published
//     block doc): a mention becomes {label: <the member's current name>} and a link
//     {label, href?} with the target's current URL, only while the target is published
//     in a public, active type. No user id, post id or email leaves the API through them.
//   - Notifications (mention_notifications.go, reminders.go) read them from the working
//     copy after a collab store.

import (
	"context"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
)

const (
	mentionNodeType     = "mention"
	contentLinkNodeType = "contentLink"
	dateChipNodeType    = "dateChip"

	// inlineLabelMaxRunes caps a mention's or link's label (INLINE_LABEL_MAX_LENGTH).
	inlineLabelMaxRunes = 200
	// defaultReminderTime is when a reminder without a time fires (DEFAULT_REMINDER_TIME).
	defaultReminderTime = "09:00"
	// maxEntityID keeps ids within what JSON numbers carry exactly (Number.isSafeInteger).
	maxEntityID = 1<<53 - 1
)

var (
	chipDateRe   = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})$`)
	chipTimeRe   = regexp.MustCompile(`^([01]\d|2[0-3]):([0-5]\d)$`)
	entityIDText = regexp.MustCompile(`^\d{1,15}$`)
)

// isInlineNodeType reports whether t is one of the #320 inline nodes.
func isInlineNodeType(t string) bool {
	return t == mentionNodeType || t == contentLinkNodeType || t == dateChipNodeType
}

// normalizeEntityID is a user or post id: a positive integer (a JSON number, or digits).
func normalizeEntityID(v interface{}) (int64, bool) {
	switch n := v.(type) {
	case float64:
		if n > 0 && n <= maxEntityID && n == math.Trunc(n) {
			return int64(n), true
		}
	case string:
		s := strings.TrimSpace(n)
		if entityIDText.MatchString(s) {
			if id, err := strconv.ParseInt(s, 10, 64); err == nil && id > 0 && id <= maxEntityID {
				return id, true
			}
		}
	}
	return 0, false
}

// normalizeInlineLabel is a label as stored: one line, trimmed, capped; "" when empty.
func normalizeInlineLabel(v interface{}) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	s = strings.Join(strings.Fields(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)), " ")
	if runes := []rune(s); len(runes) > inlineLabelMaxRunes {
		s = strings.TrimSpace(string(runes[:inlineLabelMaxRunes]))
	}
	return s
}

// normalizeChipDate is a real calendar day as YYYY-MM-DD (years 1000-9999), else "".
func normalizeChipDate(v interface{}) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	s = strings.TrimSpace(s)
	m := chipDateRe.FindStringSubmatch(s)
	if m == nil {
		return ""
	}
	year, _ := strconv.Atoi(m[1])
	if year < 1000 {
		return ""
	}
	if _, err := time.Parse("2006-01-02", s); err != nil {
		return ""
	}
	return s
}

// normalizeChipTime is HH:MM on a 24-hour clock, else "".
func normalizeChipTime(v interface{}) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	s = strings.TrimSpace(s)
	if !chipTimeRe.MatchString(s) {
		return ""
	}
	return s
}

func normalizeReminder(v interface{}) bool {
	b, ok := v.(bool)
	if ok {
		return b
	}
	s, ok := v.(string)
	return ok && s == "true"
}

// sanitizeInlineNodeAttrs returns the stored attrs of an inline node of type t, or nil
// when it can't be stored (no valid id, or date).
func sanitizeInlineNodeAttrs(t string, attrs map[string]interface{}) map[string]interface{} {
	label := normalizeInlineLabel(attrs["label"])
	labelOrNil := func() interface{} {
		if label == "" {
			return nil
		}
		return label
	}
	switch t {
	case mentionNodeType:
		id, ok := normalizeEntityID(attrs["userId"])
		if !ok {
			return nil
		}
		return map[string]interface{}{"userId": float64(id), "label": labelOrNil()}
	case contentLinkNodeType:
		id, ok := normalizeEntityID(attrs["postId"])
		if !ok {
			return nil
		}
		return map[string]interface{}{"postId": float64(id), "label": labelOrNil()}
	case dateChipNodeType:
		date := normalizeChipDate(attrs["date"])
		if date == "" {
			return nil
		}
		reminder := normalizeReminder(attrs["reminder"])
		var tm interface{}
		if s := normalizeChipTime(attrs["time"]); s != "" {
			tm = s
		} else if reminder {
			tm = defaultReminderTime
		}
		return map[string]interface{}{"date": date, "time": tm, "reminder": reminder}
	}
	return attrs
}

// sanitizeInlineNode is the sanitizer's step for one child node: the node to keep (its
// attrs replaced), a text node with its label, or nil to drop it. Marks stay.
func sanitizeInlineNode(node map[string]interface{}) map[string]interface{} {
	t := stringOf(node["type"])
	attrs, _ := node["attrs"].(map[string]interface{})
	clean := sanitizeInlineNodeAttrs(t, attrs)
	if clean != nil {
		node["attrs"] = clean
		delete(node, "content") // an atom: nothing inside
		return node
	}
	label := normalizeInlineLabel(attrs["label"])
	if t == dateChipNodeType || label == "" {
		return nil
	}
	if t == mentionNodeType {
		label = "@" + label
	}
	text := map[string]interface{}{"type": "text", "text": label}
	if marks, ok := node["marks"]; ok {
		text["marks"] = marks
	}
	return text
}

// walkInlineNodes calls f for every #320 inline node under node (pm JSON), depth first.
func walkInlineNodes(node map[string]interface{}, f func(map[string]interface{})) {
	if isInlineNodeType(stringOf(node["type"])) {
		f(node)
		return
	}
	content, _ := node["content"].([]interface{})
	for _, child := range content {
		if childMap, ok := child.(map[string]interface{}); ok {
			walkInlineNodes(childMap, f)
		}
	}
}

// blockPM is a block's pm node, or nil.
func blockPM(block interface{}) map[string]interface{} {
	blockMap, _ := block.(map[string]interface{})
	attrs, _ := blockMap["attrs"].(map[string]interface{})
	pm, _ := attrs["pm"].(map[string]interface{})
	return pm
}

// docInlineNodes calls f for every inline node of every block of a block doc map (the
// flat "blocks", so hidden and nested blocks too).
func docInlineNodes(doc map[string]interface{}, f func(blockID string, node map[string]interface{})) {
	blocks, _ := doc["blocks"].(map[string]interface{})
	for id, block := range blocks {
		if pm := blockPM(block); pm != nil {
			walkInlineNodes(pm, func(node map[string]interface{}) { f(id, node) })
		}
	}
}

// formerMemberLabel is a public mention of someone with no name to show.
const formerMemberLabel = "a former member"

// publicizeInlineNodes rewrites the inline nodes of published block docs (maps, as the
// public handlers decode them) for the public site, in place, with one lookup each for
// every doc's members and link targets:
//   - mention → {label}: the member's current name (full name, else username), else the
//     stored label, else formerMemberLabel. Never the id or an email.
//   - contentLink → {label, href}: the target's current path under the site's URL
//     structure (category_urls.go), only while it is published in a public, active type;
//     otherwise {label} alone, which the site renders as plain text.
//   - dateChip → {date, time}: the reminder flag is the editor's business.
//
// A lookup that fails leaves every mention with its stored label and every link without
// its href: the page still renders, and nothing is revealed.
func (server *Server) publicizeInlineNodes(ctx context.Context, docs ...map[string]interface{}) {
	userIDs := map[int64]bool{}
	postIDs := map[int64]bool{}
	for _, doc := range docs {
		if doc == nil {
			continue
		}
		docInlineNodes(doc, func(_ string, node map[string]interface{}) {
			attrs, _ := node["attrs"].(map[string]interface{})
			switch stringOf(node["type"]) {
			case mentionNodeType:
				if id, ok := normalizeEntityID(attrs["userId"]); ok {
					userIDs[id] = true
				}
			case contentLinkNodeType:
				if id, ok := normalizeEntityID(attrs["postId"]); ok {
					postIDs[id] = true
				}
			}
		})
	}

	names := map[int64]string{}
	if len(userIDs) > 0 {
		rows, err := server.store.ListMentionPeopleByIDs(ctx, keysOf(userIDs))
		if err != nil {
			server.logger.Warn("public mentions: member lookup failed", "count", len(userIDs), "error", err)
		}
		for _, row := range rows {
			name := strings.TrimSpace(row.FullName)
			if name == "" {
				name = row.Username
			}
			names[row.ID] = name
		}
	}
	hrefs := map[int64]string{}
	if len(postIDs) > 0 {
		rows, err := server.store.ListContentLinkTargets(ctx, keysOf(postIDs))
		if err != nil {
			server.logger.Warn("public content links: target lookup failed", "count", len(postIDs), "error", err)
		}
		if len(rows) > 0 {
			structure := urlStructureID
			if settings, err := server.store.GetSettings(ctx); err == nil {
				structure = settings.PostUrlStructure
			}
			for _, row := range rows {
				if row.PostStatus == publishedStatus && row.TypePublic && row.TypeActive {
					hrefs[row.ID] = postHref(row.PostType, row.Slug, row.ID, structure, row.CategorySlug)
				}
			}
		}
	}

	for _, doc := range docs {
		if doc == nil {
			continue
		}
		docInlineNodes(doc, func(_ string, node map[string]interface{}) {
			attrs, _ := node["attrs"].(map[string]interface{})
			label := normalizeInlineLabel(attrs["label"])
			switch stringOf(node["type"]) {
			case mentionNodeType:
				if id, ok := normalizeEntityID(attrs["userId"]); ok && names[id] != "" {
					label = names[id]
				}
				if label == "" {
					label = formerMemberLabel
				}
				node["attrs"] = map[string]interface{}{"label": label}
			case contentLinkNodeType:
				public := map[string]interface{}{"label": label}
				if id, ok := normalizeEntityID(attrs["postId"]); ok && hrefs[id] != "" {
					public["href"] = hrefs[id]
				}
				node["attrs"] = public
			case dateChipNodeType:
				chip := sanitizeInlineNodeAttrs(dateChipNodeType, attrs)
				if chip == nil {
					node["attrs"] = map[string]interface{}{}
					return
				}
				node["attrs"] = map[string]interface{}{"date": chip["date"], "time": chip["time"]}
			}
		})
	}
}

// publicizePostResponses runs publicizeInlineNodes over the published blocks of a page of
// list rows (author, term and type archives use them for excerpts).
func (server *Server) publicizePostResponses(ctx context.Context, posts []PostWithMetaResponse) {
	docs := make([]map[string]interface{}, 0, len(posts))
	for i := range posts {
		if posts[i].PublishedBlocks != nil {
			docs = append(docs, posts[i].PublishedBlocks)
		}
	}
	if len(docs) > 0 {
		server.publicizeInlineNodes(ctx, docs...)
	}
}

func keysOf(set map[int64]bool) []int64 {
	out := make([]int64, 0, len(set))
	for id := range set {
		out = append(out, id)
	}
	return out
}

// mentionTypeLabel is a post type's name as the @ menu shows it ("post" → "Post").
func mentionTypeLabel(postType string) string {
	words := strings.FieldsFunc(postType, func(r rune) bool { return r == '_' || r == '-' })
	for i, w := range words {
		runes := []rune(w)
		runes[0] = unicode.ToUpper(runes[0])
		words[i] = string(runes)
	}
	return strings.Join(words, " ")
}

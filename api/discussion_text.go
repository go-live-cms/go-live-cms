package api

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// The text of a reader comment and the name it is posted with (design 6.3, 3.5).
// Comments are plain text, validated once, here, and rendered without ever being stored
// as markup. The limits and the cases are pinned by web/src/lib/discussionTextVectors.json,
// which the form's counter reads (web/src/lib/discussion.ts) and both suites run.

const (
	// readerCommentBodyMin and readerCommentBodyMax are in characters (code points) after
	// normalizing; the max is also the column's CHECK (000061).
	readerCommentBodyMin = 2
	readerCommentBodyMax = 4000
	// readerCommentMaxBlankLines: longer runs of blank lines are cut to this many.
	readerCommentMaxBlankLines = 2
	// readerCommentNameMax is the name's limit in characters (varchar(60) in 000061).
	readerCommentNameMax = 60
)

// The 400 codes of the text rules.
const (
	readerCommentBodyInvalid  = "body_invalid"
	readerCommentBodyTooShort = "body_too_short"
	readerCommentBodyTooLong  = "body_too_long"
	readerCommentNameInvalid  = "name_invalid"
	readerCommentNameRequired = "name_required"
	readerCommentNameTooLong  = "name_too_long"
)

// isBidiControl reports the bidirectional embedding, override and isolate controls
// (U+202A–U+202E, U+2066–U+2069): they can make a comment or a name read differently
// from what it is ("Trojan Source").
func isBidiControl(r rune) bool {
	return (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069)
}

// normalizeReaderCommentBody returns the text as stored, or a code from the list above:
// CR LF and lone CR become LF; control characters other than LF and tab, and bidi
// controls, are refused; spaces and tabs ending a line go; runs of more than
// readerCommentMaxBlankLines blank lines are cut to that many; the whole is trimmed;
// then 2 to 4000 characters must remain.
func normalizeReaderCommentBody(raw string) (string, string) {
	text := strings.ReplaceAll(raw, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	if strings.ContainsFunc(text, func(r rune) bool {
		return (unicode.IsControl(r) && r != '\n' && r != '\t') || isBidiControl(r)
	}) {
		return "", readerCommentBodyInvalid
	}
	lines := strings.Split(text, "\n")
	out := make([]string, 0, len(lines))
	blank := 0
	for _, line := range lines {
		line = strings.TrimRight(line, " \t")
		if line == "" {
			blank++
			if blank > readerCommentMaxBlankLines {
				continue
			}
		} else {
			blank = 0
		}
		out = append(out, line)
	}
	text = strings.TrimSpace(strings.Join(out, "\n"))
	switch n := utf8.RuneCountInString(text); {
	case n < readerCommentBodyMin:
		return "", readerCommentBodyTooShort
	case n > readerCommentBodyMax:
		return "", readerCommentBodyTooLong
	}
	return text, ""
}

// normalizeReaderCommentName returns the name as stored (trimmed), or a code: 1 to 60
// characters, no control characters (line breaks included) and no bidi controls.
func normalizeReaderCommentName(raw string) (string, string) {
	if strings.ContainsFunc(raw, func(r rune) bool {
		return unicode.IsControl(r) || isBidiControl(r)
	}) {
		return "", readerCommentNameInvalid
	}
	name := strings.TrimSpace(raw)
	switch n := utf8.RuneCountInString(name); {
	case n == 0:
		return "", readerCommentNameRequired
	case n > readerCommentNameMax:
		return "", readerCommentNameTooLong
	}
	return name, ""
}

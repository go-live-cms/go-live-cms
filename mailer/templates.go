package mailer

import (
	"bytes"
	"embed"
	"fmt"
	htmltemplate "html/template"
	"strings"
	texttemplate "text/template"
	"time"
)

// Email templates: a plain-text and a simple HTML version of each, in
// templates/. html/template escapes the HTML ones, so a site title or role
// can't inject markup.
//
//go:embed templates/*.txt templates/*.html
var templateFS embed.FS

var (
	textTemplates = texttemplate.Must(texttemplate.ParseFS(templateFS, "templates/*.txt"))
	htmlTemplates = htmltemplate.Must(htmltemplate.ParseFS(templateFS, "templates/*.html"))
)

// Template names (Message.Template).
const (
	TemplateInvitation    = "invitation"
	TemplatePasswordReset = "password-reset"
)

// DefaultSiteTitle is used when the site title setting is empty.
const DefaultSiteTitle = "GoLive CMS"

// Invitation is the data for an invitation email.
type Invitation struct {
	SiteTitle string
	Role      string
	Link      string
	ExpiresIn time.Duration
}

// PasswordReset is the data for a password reset email. Username is
// included because it is what people sign in with and may have forgotten.
type PasswordReset struct {
	SiteTitle string
	Username  string
	Link      string
	ExpiresIn time.Duration
}

// templateData is what the templates see.
type templateData struct {
	SiteTitle string
	Role      string
	RoleA     string // "an editor", "a contributor"
	Username  string
	Link      string
	ExpiresIn string // "72 hours", "1 hour"
}

// RenderInvitation renders the invitation email to to.
func RenderInvitation(to string, d Invitation) (Message, error) {
	data := templateData{
		SiteTitle: siteTitle(d.SiteTitle),
		Role:      d.Role,
		RoleA:     withArticle(d.Role),
		Link:      d.Link,
		ExpiresIn: HumanDuration(d.ExpiresIn),
	}
	return render(to, TemplateInvitation, fmt.Sprintf("You're invited to %s", data.SiteTitle), "invitation", data)
}

// RenderPasswordReset renders the password reset email to to.
func RenderPasswordReset(to string, d PasswordReset) (Message, error) {
	data := templateData{
		SiteTitle: siteTitle(d.SiteTitle),
		Username:  d.Username,
		Link:      d.Link,
		ExpiresIn: HumanDuration(d.ExpiresIn),
	}
	return render(to, TemplatePasswordReset, fmt.Sprintf("Reset your %s password", data.SiteTitle), "password_reset", data)
}

func render(to, template, subject, file string, data templateData) (Message, error) {
	var text, html bytes.Buffer
	if err := textTemplates.ExecuteTemplate(&text, file+".txt", data); err != nil {
		return Message{}, err
	}
	if err := htmlTemplates.ExecuteTemplate(&html, file+".html", data); err != nil {
		return Message{}, err
	}
	return Message{To: to, Subject: subject, Text: text.String(), HTML: html.String(), Template: template}, nil
}

func siteTitle(title string) string {
	if title = oneLine(title); title != "" {
		return title
	}
	return DefaultSiteTitle
}

func withArticle(word string) string {
	if word == "" {
		return ""
	}
	if strings.ContainsRune("aeiouAEIOU", rune(word[0])) {
		return "an " + word
	}
	return "a " + word
}

// HumanDuration renders a link lifetime for an email: whole days from two
// days up, then hours, then minutes ("3 days", "1 hour", "30 minutes").
func HumanDuration(d time.Duration) string {
	plural := func(n int64, unit string) string {
		if n == 1 {
			return "1 " + unit
		}
		return fmt.Sprintf("%d %ss", n, unit)
	}
	switch {
	case d >= 48*time.Hour && d%(24*time.Hour) == 0:
		return plural(int64(d/(24*time.Hour)), "day")
	case d >= time.Hour && d%time.Hour == 0:
		return plural(int64(d/time.Hour), "hour")
	default:
		return plural(max(1, int64(d/time.Minute)), "minute")
	}
}

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
	TemplateInvitation     = "invitation"
	TemplatePasswordReset  = "password-reset"
	TemplateEmailChange    = "email-change"
	TemplateEmailChanged   = "email-changed"
	TemplateSignupVerify   = "signup-verify"
	TemplateSignupExisting = "signup-existing"
	TemplateAccessRequest  = "access-request"
)

// SignupVerify is the data for the open signup confirmation link (#191), sent to
// the address the account will have.
type SignupVerify struct {
	SiteTitle string
	Username  string
	Link      string
	ExpiresIn time.Duration
}

// SignupExisting is the data for the note sent instead when the address already
// has an account (#191): the signup form can't say so (account enumeration), so
// the owner hears about it. Link is the forgot-password page.
type SignupExisting struct {
	SiteTitle string
	Username  string
	Link      string
}

// RenderSignupVerify renders the signup confirmation email to to.
func RenderSignupVerify(to string, d SignupVerify) (Message, error) {
	data := templateData{
		SiteTitle: siteTitle(d.SiteTitle),
		Username:  d.Username,
		Link:      d.Link,
		ExpiresIn: HumanDuration(d.ExpiresIn),
	}
	return render(to, TemplateSignupVerify, fmt.Sprintf("Confirm your email for %s", data.SiteTitle), "signup_verify", data)
}

// RenderSignupExisting renders the "someone tried to sign up with your address"
// note to to, the existing account's address.
func RenderSignupExisting(to string, d SignupExisting) (Message, error) {
	data := templateData{
		SiteTitle: siteTitle(d.SiteTitle),
		Username:  d.Username,
		Link:      d.Link,
	}
	return render(to, TemplateSignupExisting, fmt.Sprintf("Someone tried to sign up to %s with your address", data.SiteTitle), "signup_existing", data)
}

// AccessRequest is the data for the email to a post's reviewers when a member
// asks for edit access (#321). PostTitle and Message are the member's text:
// html/template escapes them, the subject is one line.
type AccessRequest struct {
	SiteTitle string
	// Requester is the asking member's name (full name, else username).
	Requester string
	PostTitle string
	// Message is the optional note (may be empty).
	Message string
	// Link opens the post in the admin, where the request is answered.
	Link string
}

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

// EmailChange is the data for the email change confirmation, sent to the new
// address (#334).
type EmailChange struct {
	SiteTitle string
	Username  string
	Link      string
	ExpiresIn time.Duration
}

// EmailChanged is the data for the notice sent to the old address once a change
// is confirmed (#334). NewEmail is shown masked (MaskEmail).
type EmailChanged struct {
	SiteTitle string
	Username  string
	NewEmail  string
}

// templateData is what the templates see.
type templateData struct {
	SiteTitle string
	Role      string
	RoleA     string // "an editor", "a contributor"
	Username  string
	Link      string
	ExpiresIn string // "72 hours", "1 hour"
	NewEmail  string
	Requester string
	PostTitle string
	Message   string
}

// RenderAccessRequest renders the edit access request email to a reviewer.
func RenderAccessRequest(to string, d AccessRequest) (Message, error) {
	title := oneLine(d.PostTitle)
	if title == "" {
		title = "Untitled"
	}
	data := templateData{
		SiteTitle: siteTitle(d.SiteTitle),
		Requester: oneLine(d.Requester),
		PostTitle: title,
		Message:   strings.TrimSpace(d.Message),
		Link:      d.Link,
	}
	return render(to, TemplateAccessRequest, fmt.Sprintf("%s asked for edit access to %s", data.Requester, title), "access_request", data)
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

// RenderEmailChange renders the confirmation link email to the new address.
func RenderEmailChange(to string, d EmailChange) (Message, error) {
	data := templateData{
		SiteTitle: siteTitle(d.SiteTitle),
		Username:  d.Username,
		Link:      d.Link,
		ExpiresIn: HumanDuration(d.ExpiresIn),
	}
	return render(to, TemplateEmailChange, fmt.Sprintf("Confirm your new %s email address", data.SiteTitle), "email_change", data)
}

// RenderEmailChanged renders the notice to the old address after a change.
func RenderEmailChanged(to string, d EmailChanged) (Message, error) {
	data := templateData{
		SiteTitle: siteTitle(d.SiteTitle),
		Username:  d.Username,
		NewEmail:  MaskEmail(d.NewEmail),
	}
	return render(to, TemplateEmailChanged, fmt.Sprintf("Your %s email address was changed", data.SiteTitle), "email_changed", data)
}

// MaskEmail hides most of an address's local part ("ana.lima@example.com" →
// "a•••@example.com"), so a notice to the old address names the new one without
// handing it out in full to whoever reads the old inbox.
func MaskEmail(email string) string {
	local, domain, ok := strings.Cut(email, "@")
	if !ok || local == "" {
		return "•••"
	}
	first := []rune(local)[0]
	return string(first) + "•••@" + domain
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

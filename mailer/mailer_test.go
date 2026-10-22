package mailer

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net"
	"net/mail"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-live-cms/go-live-cms/util"
	"github.com/stretchr/testify/require"
)

const testLink = "https://cms.example.com/reset-password#token=SECRET-TOKEN-VALUE"

func discardLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestNewPicksAndGuardsDrivers(t *testing.T) {
	smtpConfig := util.Config{GinMode: util.GinModeRelease, SMTPHost: "smtp.example.com", SMTPPort: 587, MailFrom: "CMS <no-reply@example.com>"}

	m, err := New(smtpConfig, discardLogger())
	require.NoError(t, err)
	require.IsType(t, &smtpMailer{}, m)

	m, err = New(util.Config{GinMode: util.GinModeDebug, MailFileDir: t.TempDir()}, discardLogger())
	require.NoError(t, err)
	require.IsType(t, &fileMailer{}, m, "debug defaults to the file driver")

	m, err = New(util.Config{IsTestMode: true}, discardLogger())
	require.NoError(t, err)
	require.IsType(t, &logMailer{}, m, "tests default to the log driver")

	for name, config := range map[string]util.Config{
		"release without SMTP":      {GinMode: util.GinModeRelease},
		"release with file driver":  {GinMode: util.GinModeRelease, MailDriver: "file"},
		"release with log driver":   {GinMode: util.GinModeRelease, MailDriver: "LOG"},
		"unknown driver":            {GinMode: util.GinModeDebug, MailDriver: "sendmail"},
		"bad sender":                {GinMode: util.GinModeRelease, SMTPHost: "h", SMTPPort: 25, MailFrom: "not an address"},
		"bad port":                  {GinMode: util.GinModeRelease, SMTPHost: "h", SMTPPort: 0, MailFrom: "a@b.c"},
		"password without username": {GinMode: util.GinModeRelease, SMTPHost: "h", SMTPPort: 25, MailFrom: "a@b.c", SMTPPass: "x"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := New(config, discardLogger())
			require.Error(t, err)
		})
	}
}

func TestRenderTemplates(t *testing.T) {
	msg, err := RenderPasswordReset("user@example.com", PasswordReset{
		SiteTitle: `Acme <script>alert(1)</script>`,
		Username:  "jane",
		Link:      testLink,
		ExpiresIn: time.Hour,
	})
	require.NoError(t, err)
	require.Equal(t, TemplatePasswordReset, msg.Template)
	require.Equal(t, "Reset your Acme <script>alert(1)</script> password", msg.Subject)
	require.Contains(t, msg.Text, testLink)
	require.Contains(t, msg.Text, "jane")
	require.Contains(t, msg.Text, "1 hour")
	require.NotContains(t, msg.HTML, "<script>", "the HTML template escapes the site title")
	require.Contains(t, msg.HTML, "&lt;script&gt;")
	require.Contains(t, msg.HTML, `href="https://cms.example.com/reset-password#token=SECRET-TOKEN-VALUE"`)

	msg, err = RenderInvitation("new@example.com", Invitation{Role: "admin", Link: testLink, ExpiresIn: 72 * time.Hour})
	require.NoError(t, err)
	require.Equal(t, "You're invited to "+DefaultSiteTitle, msg.Subject)
	require.Contains(t, msg.Text, "as an admin")
	require.Contains(t, msg.Text, "3 days")
	require.Contains(t, msg.HTML, "Accept invitation")
}

func TestHumanDuration(t *testing.T) {
	for d, want := range map[time.Duration]string{
		72 * time.Hour:   "3 days",
		24 * time.Hour:   "24 hours",
		time.Hour:        "1 hour",
		90 * time.Minute: "90 minutes",
		30 * time.Second: "1 minute",
	} {
		require.Equal(t, want, HumanDuration(d), d.String())
	}
}

func TestBuildMessage(t *testing.T) {
	from := &mail.Address{Name: "Acme CMS", Address: "no-reply@acme.example"}
	_, raw, err := buildMessage(from, Message{
		To:      "Jane <jane@example.com>",
		Subject: "Hello\r\nBcc: victim@example.com",
		Text:    "plain " + testLink,
		HTML:    "<p>html</p>",
	}, time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC))
	require.NoError(t, err)

	parsed, err := mail.ReadMessage(bytes.NewReader(raw))
	require.NoError(t, err)
	require.Empty(t, parsed.Header.Get("Bcc"), "CR/LF in the subject must not start a header")
	require.Equal(t, "Hello Bcc: victim@example.com", parsed.Header.Get("Subject"))
	require.Equal(t, `"Acme CMS" <no-reply@acme.example>`, parsed.Header.Get("From"))
	require.Contains(t, parsed.Header.Get("Message-Id"), "@acme.example>")

	mediaType, params, err := mime.ParseMediaType(parsed.Header.Get("Content-Type"))
	require.NoError(t, err)
	require.Equal(t, "multipart/alternative", mediaType)
	parts := multipart.NewReader(parsed.Body, params["boundary"])
	var bodies []string
	for {
		p, err := parts.NextPart() // decodes quoted-printable
		if err == io.EOF {
			break
		}
		require.NoError(t, err)
		b, err := io.ReadAll(p)
		require.NoError(t, err)
		bodies = append(bodies, string(b))
	}
	require.Equal(t, []string{"plain " + testLink, "<p>html</p>"}, bodies)

	_, _, err = buildMessage(from, Message{To: "a@b.c, d@e.f", Text: "x"}, time.Now())
	require.Error(t, err, "one recipient only")
	_, _, err = buildMessage(from, Message{To: "a@b.c"}, time.Now())
	require.Error(t, err, "a text body is required")
}

func TestFileMailerWritesEmlAndLogsNoBody(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "mail")
	var logs bytes.Buffer
	m, err := New(util.Config{GinMode: util.GinModeDebug, MailFileDir: dir}, slog.New(slog.NewTextHandler(&logs, nil)))
	require.NoError(t, err)

	msg, err := RenderPasswordReset("jane@example.com", PasswordReset{Username: "jane", Link: testLink, ExpiresIn: time.Hour})
	require.NoError(t, err)
	require.NoError(t, m.Send(context.Background(), msg))

	files, err := os.ReadDir(dir)
	require.NoError(t, err)
	require.Len(t, files, 1)
	require.Regexp(t, `^\d{8}T\d{6}Z-password-reset-[0-9a-f]{8}\.eml$`, files[0].Name())
	info, err := files[0].Info()
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0o600), info.Mode().Perm())

	raw, err := os.ReadFile(filepath.Join(dir, files[0].Name()))
	require.NoError(t, err)
	parsed, err := mail.ReadMessage(bytes.NewReader(raw))
	require.NoError(t, err)
	require.Equal(t, "<jane@example.com>", parsed.Header.Get("To"))

	require.Contains(t, logs.String(), "password-reset")
	require.NotContains(t, logs.String(), "SECRET-TOKEN-VALUE")
	require.NotContains(t, logs.String(), "jane@example.com")
}

func TestLogMailerLogsNoBody(t *testing.T) {
	var logs bytes.Buffer
	m := &logMailer{logger: slog.New(slog.NewTextHandler(&logs, nil))}
	require.NoError(t, m.Send(context.Background(), Message{To: "a@example.com", Text: testLink, Template: TemplateInvitation}))
	require.NotContains(t, logs.String(), "SECRET-TOKEN-VALUE")
	require.Error(t, m.Send(context.Background(), Message{To: "nope", Text: "x"}))
}

// fakeSMTP is a minimal SMTP server (no TLS, no auth) that records one message.
func fakeSMTP(t *testing.T) (port int, received chan string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	t.Cleanup(func() { ln.Close() })
	received = make(chan string, 1)

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)
		write := func(s string) { _, _ = conn.Write([]byte(s + "\r\n")) }
		write("220 fake ESMTP")
		var data strings.Builder
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			cmd := strings.ToUpper(strings.TrimSpace(line))
			switch {
			case strings.HasPrefix(cmd, "EHLO"), strings.HasPrefix(cmd, "HELO"):
				write("250 fake")
			case strings.HasPrefix(cmd, "MAIL"), strings.HasPrefix(cmd, "RCPT"):
				data.WriteString(strings.TrimSpace(line) + "\n")
				write("250 OK")
			case cmd == "DATA":
				write("354 go ahead")
				for {
					l, err := r.ReadString('\n')
					if err != nil {
						return
					}
					if l == ".\r\n" {
						break
					}
					data.WriteString(l)
				}
				write("250 queued")
			case cmd == "QUIT":
				write("221 bye")
				received <- data.String()
				return
			default:
				write("502 unsupported")
			}
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, received
}

func TestSMTPMailerDelivers(t *testing.T) {
	port, received := fakeSMTP(t)
	m, err := New(util.Config{
		GinMode:  util.GinModeRelease,
		SMTPHost: "127.0.0.1",
		SMTPPort: port,
		// The fake server has no TLS; clear text is allowed to a loopback relay.
		SMTPTLS:  "none",
		MailFrom: "Acme <no-reply@acme.example>",
	}, discardLogger())
	require.NoError(t, err)

	msg, err := RenderInvitation("new@example.com", Invitation{SiteTitle: "Acme", Role: "editor", Link: testLink, ExpiresIn: 72 * time.Hour})
	require.NoError(t, err)
	require.NoError(t, m.Send(context.Background(), msg))

	select {
	case got := <-received:
		require.Contains(t, got, "MAIL FROM:<no-reply@acme.example>")
		require.Contains(t, got, "RCPT TO:<new@example.com>")
		require.Contains(t, got, "Subject: You're invited to Acme")
	case <-time.After(5 * time.Second):
		t.Fatal("no message received")
	}
}

func TestSMTPMailerReportsUnreachableServer(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()

	m, err := New(util.Config{GinMode: util.GinModeRelease, SMTPHost: "127.0.0.1", SMTPPort: port, MailFrom: "a@b.example"}, discardLogger())
	require.NoError(t, err)
	err = m.Send(context.Background(), Message{To: "x@example.com", Text: testLink})
	require.ErrorContains(t, err, "smtp dial")
	require.NotContains(t, err.Error(), "SECRET-TOKEN-VALUE")
}

// A server that doesn't offer STARTTLS must not get the message in clear
// text: an on-path attacker could strip the STARTTLS capability.
func TestSMTPMailerRequiresStartTLS(t *testing.T) {
	port, received := fakeSMTP(t)
	m, err := New(util.Config{GinMode: util.GinModeRelease, SMTPHost: "127.0.0.1", SMTPPort: port, MailFrom: "a@b.example"}, discardLogger())
	require.NoError(t, err)

	err = m.Send(context.Background(), Message{To: "x@example.com", Text: testLink})
	require.ErrorContains(t, err, "STARTTLS")
	select {
	case got := <-received:
		require.NotContains(t, got, "SECRET-TOKEN-VALUE")
		require.NotContains(t, got, "RCPT TO")
	case <-time.After(200 * time.Millisecond):
	}
}

func TestSMTPTLSMode(t *testing.T) {
	base := util.Config{GinMode: util.GinModeRelease, SMTPPort: 587}
	for name, tc := range map[string]struct {
		configure func(*util.Config)
		host      string
		want      string
		wantErr   bool
	}{
		"default is STARTTLS":     {func(*util.Config) {}, "smtp.example.com", smtpTLSStartTLS, false},
		"port 465 is implicit":    {func(c *util.Config) { c.SMTPPort = 465 }, "smtp.example.com", smtpTLSImplicit, false},
		"explicit tls":            {func(c *util.Config) { c.SMTPTLS = "TLS" }, "smtp.example.com", smtpTLSImplicit, false},
		"none to a remote host":   {func(c *util.Config) { c.SMTPTLS = "none" }, "smtp.example.com", "", true},
		"none to loopback":        {func(c *util.Config) { c.SMTPTLS = "none" }, "localhost", smtpTLSNone, false},
		"none to loopback IPv6":   {func(c *util.Config) { c.SMTPTLS = "none" }, "::1", smtpTLSNone, false},
		"none in debug (Mailpit)": {func(c *util.Config) { c.SMTPTLS = "none"; c.GinMode = util.GinModeDebug }, "mailpit", smtpTLSNone, false},
		"unknown value":           {func(c *util.Config) { c.SMTPTLS = "ssl" }, "smtp.example.com", "", true},
	} {
		t.Run(name, func(t *testing.T) {
			config := base
			tc.configure(&config)
			got, err := smtpTLSMode(config, tc.host)
			if tc.wantErr {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tc.want, got)
		})
	}

	_, err := New(util.Config{GinMode: util.GinModeRelease, SMTPHost: "smtp.example.com", SMTPPort: 25, SMTPTLS: "none", MailFrom: "a@b.example"}, discardLogger())
	require.ErrorContains(t, err, "clear text", "startup refuses clear-text SMTP in release")
}

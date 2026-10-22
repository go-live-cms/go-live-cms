// Package mailer sends the API's transactional email (#148): invitations and
// password resets.
//
// # Drivers
//
//   - smtp: the only driver allowed in release mode. Needs SMTP_HOST and
//     MAIL_FROM; New fails without them, so the API refuses to start rather
//     than silently dropping every invitation and reset email.
//   - file: debug default. Writes each email as a .eml file to MAIL_FILE_DIR
//     (open it in a mail client, or read the link out of it).
//   - log: test default. Logs that an email was sent, never its body.
//
// Emails carry single-use tokens in their links, so a message body is never
// logged, and errors never include it.
package mailer

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/mail"
	"strings"

	"github.com/go-live-cms/go-live-cms/util"
)

// Message is one email. Text is required; HTML is the optional alternative.
// Template names the kind of email (for logs: never the body).
type Message struct {
	To       string
	Subject  string
	Text     string
	HTML     string
	Template string
}

// Mailer delivers email. Implementations must be safe for concurrent use.
type Mailer interface {
	Send(ctx context.Context, msg Message) error
}

// New builds the mailer config asks for (config.MailDriverName). It fails on
// an unknown driver, on file/log outside debug and test mode, and on an
// incomplete SMTP setup.
func New(config util.Config, logger *slog.Logger) (Mailer, error) {
	driver := config.MailDriverName()
	devOnly := config.IsDebugMode() || config.IsTestMode

	switch driver {
	case util.MailDriverSMTP:
		return newSMTPMailer(config)
	case util.MailDriverFile, util.MailDriverLog:
		if !devOnly {
			return nil, fmt.Errorf("MAIL_DRIVER=%s is for development only: configure SMTP (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM) outside debug mode", driver)
		}
		from, err := parseFrom(config.MailFrom, "GoLive CMS <no-reply@localhost>")
		if err != nil {
			return nil, err
		}
		if driver == util.MailDriverFile {
			return newFileMailer(config.MailFileDir, from, logger)
		}
		return &logMailer{logger: logger}, nil
	default:
		return nil, fmt.Errorf("invalid MAIL_DRIVER %q: must be %q, %q or %q", config.MailDriver, util.MailDriverSMTP, util.MailDriverFile, util.MailDriverLog)
	}
}

// parseFrom parses MAIL_FROM, falling back to def when it is empty (def ""
// makes it required).
func parseFrom(raw, def string) (*mail.Address, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		if def == "" {
			return nil, errors.New("MAIL_FROM is required (the sender address, e.g. \"GoLive CMS <no-reply@example.com>\")")
		}
		raw = def
	}
	addr, err := mail.ParseAddress(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid MAIL_FROM %q: %w", raw, err)
	}
	return addr, nil
}

// logMailer drops every email after logging that it would have sent one.
type logMailer struct {
	logger *slog.Logger
}

func (m *logMailer) Send(_ context.Context, msg Message) error {
	if _, err := mail.ParseAddress(msg.To); err != nil {
		return fmt.Errorf("invalid recipient: %w", err)
	}
	m.logger.Info("email not sent (MAIL_DRIVER=log)", "template", msg.Template)
	return nil
}

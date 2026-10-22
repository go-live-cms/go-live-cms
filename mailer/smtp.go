package mailer

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"

	"github.com/go-live-cms/go-live-cms/util"
)

// smtpTimeout bounds one delivery (dial through QUIT) when ctx has no
// earlier deadline.
const smtpTimeout = 30 * time.Second

// SMTP connection security (SMTP_TLS).
const (
	smtpTLSStartTLS = "starttls"
	smtpTLSImplicit = "tls"
	smtpTLSNone     = "none"
)

// smtpMailer delivers through an SMTP server. TLS is required by default:
// implicit on port 465, STARTTLS otherwise, and a server that doesn't offer
// STARTTLS is an error, not a fallback to clear text (which an on-path
// attacker could force by stripping it). Emails carry working links.
type smtpMailer struct {
	host     string
	port     int
	tlsMode  string
	username string
	password string
	from     *mail.Address
	now      func() time.Time
	// tlsConfig is nil in production (verify against host); tests inject one.
	tlsConfig *tls.Config
}

func newSMTPMailer(config util.Config) (*smtpMailer, error) {
	host := strings.TrimSpace(config.SMTPHost)
	if host == "" {
		return nil, errors.New("SMTP_HOST is required: outside debug mode the API must be able to send invitation and password reset emails (or set MAIL_DRIVER=file in development)")
	}
	if config.SMTPPort <= 0 || config.SMTPPort > 65535 {
		return nil, fmt.Errorf("invalid SMTP_PORT %d", config.SMTPPort)
	}
	from, err := parseFrom(config.MailFrom, "")
	if err != nil {
		return nil, err
	}
	if (config.SMTPUser == "") != (config.SMTPPass == "") {
		return nil, errors.New("SMTP_USER and SMTP_PASS must be set together")
	}
	tlsMode, err := smtpTLSMode(config, host)
	if err != nil {
		return nil, err
	}
	return &smtpMailer{
		host:     host,
		port:     config.SMTPPort,
		tlsMode:  tlsMode,
		username: config.SMTPUser,
		password: config.SMTPPass,
		from:     from,
		now:      time.Now,
	}, nil
}

// smtpTLSMode resolves SMTP_TLS. Clear text ("none") is only allowed in
// debug/test mode (e.g. Mailpit) or to a loopback relay.
func smtpTLSMode(config util.Config, host string) (string, error) {
	mode := strings.ToLower(strings.TrimSpace(config.SMTPTLS))
	switch mode {
	case "":
		if config.SMTPPort == 465 {
			return smtpTLSImplicit, nil
		}
		return smtpTLSStartTLS, nil
	case smtpTLSStartTLS, smtpTLSImplicit:
		return mode, nil
	case smtpTLSNone:
		if config.IsDebugMode() || config.IsTestMode || isLoopbackHost(host) {
			return mode, nil
		}
		return "", fmt.Errorf("SMTP_TLS=none sends reset and invitation links in clear text; it is only allowed in debug mode or to a loopback host")
	default:
		return "", fmt.Errorf("invalid SMTP_TLS %q: must be %q, %q or %q", config.SMTPTLS, smtpTLSStartTLS, smtpTLSImplicit, smtpTLSNone)
	}
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (m *smtpMailer) tlsConf() *tls.Config {
	if m.tlsConfig != nil {
		return m.tlsConfig
	}
	return &tls.Config{ServerName: m.host, MinVersion: tls.VersionTLS12}
}

func (m *smtpMailer) Send(ctx context.Context, msg Message) error {
	to, raw, err := buildMessage(m.from, msg, m.now())
	if err != nil {
		return err
	}

	deadline := time.Now().Add(smtpTimeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	addr := net.JoinHostPort(m.host, strconv.Itoa(m.port))
	dialer := &net.Dialer{Deadline: deadline}

	var conn net.Conn
	if m.tlsMode == smtpTLSImplicit {
		conn, err = (&tls.Dialer{NetDialer: dialer, Config: m.tlsConf()}).DialContext(ctx, "tcp", addr)
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("smtp dial: %w", err)
	}
	if err := conn.SetDeadline(deadline); err != nil {
		conn.Close()
		return err
	}

	c, err := smtp.NewClient(conn, m.host)
	if err != nil {
		conn.Close()
		return fmt.Errorf("smtp greeting: %w", err)
	}
	defer c.Close()

	if m.tlsMode == smtpTLSStartTLS {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			return errors.New("smtp: server does not offer STARTTLS (use SMTP_TLS=tls for implicit TLS)")
		}
		if err := c.StartTLS(m.tlsConf()); err != nil {
			return fmt.Errorf("smtp starttls: %w", err)
		}
	}
	if m.username != "" {
		if err := c.Auth(smtp.PlainAuth("", m.username, m.password, m.host)); err != nil {
			return fmt.Errorf("smtp auth: %w", err)
		}
	}
	if err := c.Mail(m.from.Address); err != nil {
		return fmt.Errorf("smtp MAIL FROM: %w", err)
	}
	if err := c.Rcpt(to.Address); err != nil {
		return fmt.Errorf("smtp RCPT TO: %w", err)
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("smtp DATA: %w", err)
	}
	if _, err := w.Write(raw); err != nil {
		return fmt.Errorf("smtp write: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("smtp end of data: %w", err)
	}
	return c.Quit()
}

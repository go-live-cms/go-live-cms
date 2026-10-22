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

// smtpMailer delivers through an SMTP server. Port 465 is implicit TLS;
// otherwise STARTTLS is used whenever the server offers it, and required when
// credentials are configured (net/smtp's PLAIN auth refuses to send them in
// clear text except to localhost).
type smtpMailer struct {
	host     string
	port     int
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
	return &smtpMailer{
		host:     host,
		port:     config.SMTPPort,
		username: config.SMTPUser,
		password: config.SMTPPass,
		from:     from,
		now:      time.Now,
	}, nil
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
	if m.port == 465 {
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

	if m.port != 465 {
		if ok, _ := c.Extension("STARTTLS"); ok {
			if err := c.StartTLS(m.tlsConf()); err != nil {
				return fmt.Errorf("smtp starttls: %w", err)
			}
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

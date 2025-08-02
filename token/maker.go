package token

import "time"

type Maker interface {
	CreateToken(userID int64, username string, duration time.Duration) (string, error)

	CreateRefreshToken(userID int64, username string, duration time.Duration) (string, error)

	VerifyToken(token string) (*Payload, error)
}

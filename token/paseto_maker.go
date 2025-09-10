package token

import (
	"fmt"
	"time"

	"github.com/aead/chacha20poly1305"
	"github.com/o1egl/paseto"
)

type PasetoMaker struct {
	paseto       *paseto.V2
	symmetricKey []byte
}

func NewPasetoMaker(symmetricKey string) (Maker, error) {
	if len(symmetricKey) != chacha20poly1305.KeySize {
		return nil, fmt.Errorf("invalid symmetric key size: must be %d bytes", chacha20poly1305.KeySize)
	}
	maker := &PasetoMaker{
		paseto:       paseto.NewV2(),
		symmetricKey: []byte(symmetricKey),
	}
	return maker, nil
}

func (maker *PasetoMaker) CreateToken(userID int64, username string, duration time.Duration) (string, error) {
	payload, err := NewPayload(userID, username, duration, "access")
	if err != nil {
		return "", err
	}
	return maker.paseto.Encrypt(maker.symmetricKey, payload, nil)
}

func (maker *PasetoMaker) CreateRefreshToken(userID int64, username string, duration time.Duration) (string, error) {
	payload, err := NewPayload(userID, username, duration, "refresh")
	if err != nil {
		return "", err
	}
	return maker.paseto.Encrypt(maker.symmetricKey, payload, nil)
}

func (maker *PasetoMaker) CreateWSTicket(userID int64, username string, postID int64, duration time.Duration) (string, error) {
	payload, err := NewPayload(userID, username, duration, "ws_ticket")
	if err != nil {
		return "", err
	}

	// Add custom claims for the ticket
	ticketPayload := struct {
		*Payload
		PostID int64 `json:"post_id"`
	}{
		Payload: payload,
		PostID:  postID,
	}

	return maker.paseto.Encrypt(maker.symmetricKey, ticketPayload, nil)
}

func (maker *PasetoMaker) VerifyToken(token string) (*Payload, error) {
	payload := &Payload{}

	err := maker.paseto.Decrypt(token, maker.symmetricKey, payload, nil)
	if err != nil {
		return nil, ErrInvalidToken
	}

	err = payload.Valid()
	if err != nil {
		return nil, err
	}
	return payload, nil
}

# PASETO key rotation

The API holds three PASETO v4 keys (see `util/config.go`):

| Key | Env var | Signs / encrypts | Token lifetime |
|-----|---------|------------------|----------------|
| Ed25519 private + public | `PASETO_V4_PRIVATE_KEY_HEX`, `PASETO_V4_PUBLIC_KEY_HEX` | access tokens (`v4.public`) and collab tickets | `ACCESS_TOKEN_DURATION` (default 15m); tickets 30s |
| Symmetric local | `PASETO_V4_LOCAL_KEY_HEX` | refresh tokens (`v4.local`) | `REFRESH_TOKEN_DURATION` (default 720h) |

The collab server (`collab` service) verifies collab tickets with the same public key:
`PASETO_V4_PUBLIC_KEY_HEX` (prod `compose.yaml` passes it from `.env`; in dev the
`collab-key` service copies it from `app.env` on every `up`), or a PEM file in
`PASETO_V4_PUBLIC_PEM_FILE`.

## Policy

- **Rotate on suspicion of compromise, immediately.** Then skip the grace window below:
  a leaked key must stop working at once, and every user signs in again.
- **Rotate routinely once a year**, and whenever someone who had access to the secret
  store leaves. Use the grace window so nobody is signed out.
- Generate new keys with the same tool you used for the first ones. Never reuse a key.
- Change the KID with each rotation (`PASETO_ACCESS_KID`, `PASETO_REFRESH_KID`, e.g.
  `k4.pub.2026-11`), so sessions show which key minted their refresh token.

## Grace window

Tokens are always minted with the current keys. While a rotation is in progress, the
retired keys can still **verify** tokens they produced, until a cutoff:

```sh
PASETO_V4_PREVIOUS_PUBLIC_KEY_HEX=<old public key>   # optional: access tokens
PASETO_V4_PREVIOUS_LOCAL_KEY_HEX=<old local key>     # optional: refresh tokens
PASETO_PREVIOUS_KEYS_VALID_UNTIL=2026-12-01T00:00:00Z  # required with either key
```

- Set only the key(s) you rotated. Either can be omitted.
- `PASETO_PREVIOUS_KEYS_VALID_UNTIL` is RFC 3339. The API refuses to start if a previous
  key is set without it. After the cutoff the previous keys are ignored even if they are
  still configured, so a forgotten setting can't keep a retired key alive.
- Pick the cutoff from the lifetime of the tokens the old key issued: at least
  `ACCESS_TOKEN_DURATION` after the deploy for the public key, and
  `REFRESH_TOKEN_DURATION` for the local key. A refresh with an old-key refresh token
  returns a new-key one, so active users move over on their next refresh; only idle
  sessions need the full window. A shorter window just signs those users out.
- Collab tickets have no grace window: they live 30 seconds.

## Procedure

1. Generate the new key(s).
2. Deploy the API with the new keys as the current ones, the old ones in the
   `PASETO_V4_PREVIOUS_*` variables, a cutoff, and new KIDs.
3. Restart the collab server with the new public key **at the same time** as the API.
   Tickets are signed with the new key from the moment the API restarts, and the collab
   server only knows one key, so until both run the new key, opening an editor fails
   (it retries; nothing is lost).
4. After the cutoff, remove the `PASETO_V4_PREVIOUS_*` and
   `PASETO_PREVIOUS_KEYS_VALID_UNTIL` variables and destroy the old keys.

For a compromise, do steps 1 and 3 and deploy the new keys with **no** previous keys.
Without the old local key no existing refresh token decrypts, and without the old public
key no existing access token verifies, so every session ends and everyone signs in again.

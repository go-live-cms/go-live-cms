# PASETO key rotation

The API holds three PASETO v4 keys (see `util/config.go`):

| Key | Env var | Signs / encrypts | Token lifetime |
|-----|---------|------------------|----------------|
| Ed25519 private + public | `PASETO_V4_PRIVATE_KEY_HEX`, `PASETO_V4_PUBLIC_KEY_HEX` | access tokens (`v4.public`) and collab tickets | `ACCESS_TOKEN_DURATION` (default 15m); tickets 30s |
| Symmetric local | `PASETO_V4_LOCAL_KEY_HEX` | refresh tokens (`v4.local`) | `REFRESH_TOKEN_DURATION` (default 720h; 24h in prod `compose.yaml`) |

Each token's footer names the key that made it: `{"kid": "<PASETO_ACCESS_KID>"}` on access
tokens and tickets, `PASETO_REFRESH_KID` on refresh tokens (the session row keeps it as
`refresh_kid`). Any of these can be read from a file with `<NAME>_FILE`; prod
`compose.yaml` does that for the private and local keys ([deploy.md](deploy.md), "Secrets").

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
- **Give every new key a new KID** (`PASETO_ACCESS_KID`, `PASETO_REFRESH_KID`, e.g.
  `k4.pub.2026-11`). The verifier picks the key by KID, so the grace window needs it: the
  API refuses to start if a previous key has the current KID.

## Grace window

Tokens are always minted with the current keys. While a rotation is in progress, the
retired keys can still **verify** tokens they produced, until a cutoff. List each one under
the KID its tokens carry, as comma-separated `<kid>=<hex key>` entries:

```sh
PASETO_V4_PREVIOUS_PUBLIC_KEYS=k4.pub.2025-09=<old public key hex>   # optional: access tokens
PASETO_V4_PREVIOUS_LOCAL_KEYS=k4.loc.2025-09=<old local key hex>     # optional: refresh tokens
PASETO_PREVIOUS_KEYS_VALID_UNTIL=2026-12-01T00:00:00Z                # required with either list
```

- **How a token is verified** (`token/paseto_v4_rotation.go`): the API reads the KID from
  the footer and uses exactly that key: the current KID → the current key, a listed KID →
  that previous key (until the cutoff). A token with any other KID, or none, is rejected
  without trying a key. The footer is authenticated with the token, so a forged KID can't
  make another key accept it.
- **Several generations:** list more entries (`k4.loc.2025-09=…,k4.loc.2026-03=…`) when
  you rotate again before an earlier window has ended. They share the one cutoff, so set
  it from the newest rotation, and drop entries whose tokens can no longer be alive.
- **Changed a KID without changing the key** (by mistake, or on purpose): tokens with the
  old KID no longer find a key. List the *current* key under the old KID to bridge them
  (`PASETO_V4_PREVIOUS_LOCAL_KEYS=<old kid>=<current local key hex>`).
- In production, set these (and the new keys and KIDs) in the GitHub `production`
  environment, not in the VM's `.env`: every deploy rewrites that file from GitHub
  ([deploy.md](deploy.md), step 3). The previous-key lists are secrets, the cutoff and
  KIDs variables. Then run a deploy. Commas, `=` and `.` are fine in a value; quotes and
  newlines aren't.
- Set only the list(s) you rotated. Either can be omitted.
- `PASETO_PREVIOUS_KEYS_VALID_UNTIL` is RFC 3339. The API refuses to start if a previous
  key is set without it, if an entry isn't `<kid>=<hex>`, if a KID is listed twice, or if
  a key doesn't parse. After the cutoff the previous keys are ignored even if they are
  still configured, so a forgotten setting can't keep a retired key alive.
- Pick the cutoff from the lifetime of the tokens the old key issued: at least
  `ACCESS_TOKEN_DURATION` after the deploy for the public key, and
  `REFRESH_TOKEN_DURATION` for the local key. A refresh with an old-key refresh token
  returns a new-key one, so active users move over on their next refresh; only idle
  sessions need the full window. A shorter window just signs those users out.
- Collab tickets have no grace window: they live 30 seconds.
- **Renamed in #158:** `PASETO_V4_PREVIOUS_PUBLIC_KEY_HEX` / `PASETO_V4_PREVIOUS_LOCAL_KEY_HEX`
  (one key, no KID, tried after the current key failed) are no longer read; the API
  refuses to start while either is set and names the replacement. Move the value into the
  new list under the KID the old tokens carry (`PASETO_ACCESS_KID`/`PASETO_REFRESH_KID`
  before the rotation; `k4.pub.2025-09`/`k4.loc.2025-09` if they were never set).

## Procedure

1. Generate the new key(s) and pick new KIDs.
2. Deploy the API with the new keys and KIDs as the current ones, the old ones in the
   `PASETO_V4_PREVIOUS_*_KEYS` lists under their old KIDs, and a cutoff.
3. Restart the collab server with the new public key **at the same time** as the API.
   Tickets are signed with the new key from the moment the API restarts, and the collab
   server only knows one key, so until both run the new key, opening an editor fails
   (it retries; nothing is lost). A deploy (`deploy.sh`) recreates both together.
4. After the cutoff, remove the `PASETO_V4_PREVIOUS_*_KEYS` and
   `PASETO_PREVIOUS_KEYS_VALID_UNTIL` variables and destroy the old keys.

For a compromise, do steps 1 and 3 and deploy the new keys with **no** previous keys.
Without the old local key no existing refresh token decrypts, and without the old public
key no existing access token verifies, so every session ends and everyone signs in again.

## Shared secrets (`ROLE_LOOKUP_SECRET`, `COLLAB_INTERNAL_SECRET`)

Two bearer secrets between the API and the collab server, on the unpublished internal
listeners: `ROLE_LOOKUP_SECRET` (collab → API: access lookups, document load and store) and
`COLLAB_INTERNAL_SECRET` (API → collab: the flush before a publish). They never reach a
browser and sign nothing, so there is no token to keep verifying and no grace window:
each side accepts exactly one value. Both read `<NAME>_FILE`, and prod `compose.yaml`
passes both as files.

- **Rotate** them when someone with access to the secret store leaves, or on suspicion.
  Generate a new random value (`openssl rand -hex 32`), set it in the GitHub `production`
  environment and deploy: `deploy.sh` recreates the API and the collab server together.
- **While the two sides disagree** (seconds, during the restart): new editor connections
  are refused as `access-unavailable` and the editor retries; open connections keep their
  mode (the access re-check fails open for `COLLAB_ACCESS_GRACE_MS`, 2 minutes); a publish
  answers 503 and nothing is published. Nothing is lost: the collab server keeps unstored
  edits in memory and retries the store. Never restart only one side with a new value.
- On a compromise, rotate both right away; they don't expire on their own.

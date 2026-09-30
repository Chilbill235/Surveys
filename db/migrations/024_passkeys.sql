-- 024: passkeys (WebAuthn credentials)
--
-- A passkey is a signing key created by the device -- Touch ID, Face ID, Windows Hello, a
-- hardware token, an Android screen lock. The private key never leaves the device's secure
-- hardware and never reaches this server; what is stored here is the public half, so that a
-- later assertion can be checked against it.
--
-- One row per credential, not one row per user, because a person can have several: a phone, a
-- laptop, a security key. A user with a phone passkey and a laptop passkey has two rows, and
-- removing one has to leave the other working.
--
-- Why a separate table rather than a column on `users`:
--
--   * The cardinality is genuinely one-to-many. A `passkey` column on `users` would have to
--     hold a list, and there is no good list type here -- it would be JSON with no referential
--     integrity, so deleting a device becomes a read-modify-write on a JSON blob and a
--     concurrent one from another device silently overwrites it.
--   * A credential has its own lifecycle. It has a sign counter, a last-used timestamp, a
--     transport hint, and a label the user chose ("Work laptop"). None of those belong on a
--     user row, and adding them there would make every user row carry columns that are NULL
--     for everyone not using a passkey.
--   * A user must be able to see and revoke a device without a password reset. That is the
--     whole point of having a list, and it needs rows to point at.
--
-- `credential_id` is the base64url string the authenticator generated, and it is the primary
-- key because it is what an assertion is looked up by. It is a large opaque value from a
-- hardware authenticator, so the column is `TEXT` and the primary key is on the value itself
-- rather than a surrogate: there is no reason to renumber something the authenticator named,
-- and using the real identifier means a lookup cannot be pointed at a row by guessing a
-- sequence.
--
-- `public_key` is the COSE public key, base64url encoded, as produced by
-- `@simplewebauthn/server`. It is stored as text and handed back to the library as bytes
-- after the reverse conversion, and it is never re-encoded by anything in between: the
-- library is what parses COSE, and a second understanding of the format here would show up
-- as passkeys that stop working with no error anywhere.
--
-- Text rather than `BYTEA`, deliberately. The bytes are correct either way, but a text
-- column survives a `psql` dump, a JSON export, and a log line without escaping, so a bad row
-- can actually be looked at. The conversion happens in exactly two places in
-- `src/services/passkeys.js` and nowhere else.
--
-- `counter` is the authenticator's signature counter. WebAuthn requires it to increase on
-- every assertion from a multi-device credential; a repeated value is the signal that an
-- assertion has been cloned, and the library raises on it. It starts at 0, which is also
-- what a single-device authenticator reports forever, so the column is `NOT NULL DEFAULT 0`
-- and never NULL.
--
-- `transports` is a comma-separated list from the authenticator's own response
-- ("usb", "nfc", "ble", "internal", "hybrid"). It is a hint used to decide how to ask the
-- browser to reach the credential, and it is advisory only -- an authenticator may report
-- something its platform later stops supporting. A stale or wrong entry here costs a failed
-- attempt, never a lockout, which is why it is not a lookup key.
--
-- `name` is the label the user gave the device, for the list they revoke from. Nullable,
-- because the first passkey is registered before anyone is asked what to call it.

BEGIN;

CREATE TABLE IF NOT EXISTS passkeys (
    -- The base64url credential id the authenticator generated.
    credential_id TEXT PRIMARY KEY,

    -- The owning account. `ON DELETE CASCADE` because a credential without an account is
    -- meaningless and unreachable: nothing can authenticate as it, since every sign-in path
    -- resolves an account first. Deleting the account takes its devices with it, which is
    -- also what someone closing an account expects.
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    -- base64url COSE public key, stored and returned exactly as the library produced it.
    public_key TEXT NOT NULL,

    -- The authenticator's signature counter. NOT NULL DEFAULT 0 because a single-device
    -- authenticator never increments it and always reports 0, and a NULL here would be
    -- indistinguishable from "never recorded".
    counter BIGINT NOT NULL DEFAULT 0,

    -- The authenticator's attestation GUID, when it gave one. Nullable because "none"
    -- attestation -- the default, and what most platform authenticators use -- reports none.
    -- Used for deduplicating the same physical key registered twice.
    device_type TEXT,

    -- Comma-separated transport hints. Advisory, as described above.
    transports TEXT,

    -- The user's own label for this device.
    name TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);

-- Sign-in is always "find every credential this user can use", so the read is by user.
-- Without this index it is a sequential scan of a table that, unlike `users`, is expected to
-- grow steadily -- a user with three devices adds three rows and sign-in looks at all of
-- them on every attempt.
CREATE INDEX IF NOT EXISTS passkeys_user_id_idx ON passkeys (user_id);

-- The list a user revokes devices from is ordered newest-first.
CREATE INDEX IF NOT EXISTS passkeys_user_created_idx ON passkeys (user_id, created_at DESC);

COMMIT;

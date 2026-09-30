-- 023: display name and profile picture
--
-- Both columns are nullable and a user who has never set either keeps `NULL`, so adding
-- them changes nothing for an existing account until the user acts. That is why there is no
-- backfill: there is no correct value to invent for someone who has not chosen a name.
--
-- `display_name` is presentation only. It is never an identifier, never an authorisation
-- input, and never resolved against another account -- it is shown next to the user's own
-- balance. That distinction is why it does not need to be unique, and why a rename cannot
-- affect a ledger row, a deposit, or a session. The stable identity of an account stays
-- `users.id` / `users.email`, and nothing reads this column to decide what a user may do.
--
-- `avatar_data` holds a `data:` URL rather than a path to a file on disk. The reasons are
-- deployment constraints, not preference:
--
--   * This service deploys to Vercel, where the filesystem is ephemeral and per-invocation.
--     A file written during a request is gone by the next one, so an on-disk avatar would
--     work in `npm run dev` and 404 in production -- a difference that only shows up after
--     deploy.
--   * There is no object storage configured. Adding one (S3, R2, Cloudinary) to hold a
--     16 KB image is a dependency, a credential, a bucket, and a lifecycle policy to
--     maintain, all to store something the database can hold.
--
-- The trade-off is that the bytes live in the `users` row, so the row grows. That is
-- acceptable at the size this column is allowed to reach: `src/services/profile.js` caps a
-- decoded image at 16 KB, and the JSON body parser caps the whole request at 32 KB, so a
-- row cannot be grown into a denial of service by a client posting a large picture. A
-- product that later needed full-resolution uploads should move the image to object
-- storage and keep only a URL here; the column shape does not need to change for that.

BEGIN;

-- The name the user chose to be called. Free text rather than an enum or a handle, so it
-- can hold what a person actually types -- an apostrophe, an accent, a space.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS display_name TEXT;

-- A `data:image/<type>;base64,<...>` URL, validated before it is written. `NULL` means the
-- account has no picture and the interface falls back to the brand mark.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS avatar_data TEXT;

COMMIT;

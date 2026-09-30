-- The per-user switch for money email.
--
-- Money email is split into two kinds, and only one of them is switchable:
--
--   * Security and authorisation mail -- email verification, password reset, the withdrawal
--     confirmation code. A user who does not receive these cannot confirm the account,
--     cannot get back in, and cannot finish a withdrawal. There is no state in which
--     suppressing them is better than receiving them, so they are sent unconditionally and
--     no column is consulted.
--
--   * Money notifications -- deposit instructions, deposit credited, deposit failed,
--     withdrawal started, withdrawal sent, withdrawal refunded. These are the receipts and
--     the progress updates. The account page shows every one of them, so they are
--     informational rather than load-bearing, which is what makes them switchable.
--
-- The column is `NOT NULL DEFAULT TRUE`, which is the part that matters operationally. The
-- existing send paths are written to treat "no row" and "false" the same way, but a
-- deployment that runs this migration gets `TRUE` for every existing user, so adding the
-- switch does not silently mute anyone who had already relied on the receipts.
--
-- Named rather than a generic `email_opt_in`, because the column does not gate email in
-- general. A name like that invites the next person to wire it into the verification and
-- reset paths, which would lock users out of their own accounts.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS money_emails_enabled BOOLEAN NOT NULL DEFAULT TRUE;

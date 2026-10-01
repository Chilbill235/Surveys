-- Notifications that survive the tab closing.
--
-- Every notification in this product was in `sessionStorage` in the reader's own browser. That has
-- three consequences, all of them things a person notices:
--
--   - A notification is gone when the tab is closed. A deposit that credited at midnight is not
--     announced at 9am; the money is there, and nothing says why it went up.
--   - It does not follow the reader. Signing in on a phone shows an empty bell next to a balance
--     that says otherwise, which reads as a bug in the balance.
--   - Read state is per-browser. Marking a notification read on the desktop leaves it unread on
--     the phone, and the badge count disagrees with the list.
--
-- This table is the record. It is written by the server at the moment the event happens, so it
-- does not depend on anybody having a tab open, and it is read by the API rather than by the
-- browser, so the bell is the same everywhere.
--
-- The columns are deliberately the ones the notification renderer already needs. `category` and
-- `record_id` are what make a notification actionable: they resolve to the deposit receipt, the
-- withdrawal row or the ledger row the reader wants to look at, and they are what the unique index
-- below is built on. `tone` is carried rather than derived, because "this is an error" is a
-- judgement made where the event is known -- a provider's reason for a failed payout is available
-- in the payout record and nowhere else.
--
-- `record_id` is TEXT, not an integer, on purpose: a notification is not always about a row with
-- an id we own. A refund has a ledger id, a chargeback has a provider id, and a system notice has
-- neither. TEXT is what lets one table carry all three without a second nullable id column and the
-- nullable joins that come with it.
--
-- `read_at` rather than a boolean, so "read" can be ordered and audited, and so a future "unread
-- since you were last here" does not need a second column.
--
-- The unique index is the important part. A deposit is credited by the webhook, by the
-- reconciliation job, and by an operator retrying a row, and all three write the same event. With
-- an index on (user_id, category, record_id) the second write is a no-op instead of a second bell
-- item saying the same thing twice. It is partial so that a notification with no record -- a system
-- notice, a message that is not about one record -- is not deduplicated against all other such
-- notices: two of those are two different things and both belong in the list.
CREATE TABLE IF NOT EXISTS notifications (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Which part of the product this is about: `deposit`, `withdrawal`, `reward`, `survey`,
    -- `system`. Kept as a free string rather than an enum because the client already switches on
    -- it and a new category should not need a migration to render.
    category TEXT NOT NULL,
    tone TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL,
    message TEXT,
    -- Where the notification goes when it is clicked. Stored as it will be used, not as a set of
    -- parts to reassemble, so a notification that links to a fragment on the account page keeps
    -- pointing at that fragment when the page moves.
    href TEXT,
    -- The id of the thing this is about, if it is about one thing. See the note above on TEXT.
    record_id TEXT,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The list is read as "this user's notifications, newest first", on every page load and after
-- every live update. The index is on (user_id, id DESC) so that read is a backwards index scan of
-- exactly the rows for this user rather than a sort over the table.
CREATE INDEX IF NOT EXISTS notifications_user_id_idx ON notifications (user_id, id DESC);

-- The bell badge counts unread rows for this user, on every poll. A partial index on the unread
-- subset alone keeps that count cheap as the table grows with read history.
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- One notification per event. See the header for why a duplicate is the failure this prevents.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_event_uniq
    ON notifications (user_id, category, record_id)
    WHERE record_id IS NOT NULL;

COMMENT ON TABLE notifications IS
    'Durable per-user notification records, written by the server at the moment of the event.';
COMMENT ON COLUMN notifications.record_id IS
    'Identifier of the record this notification is about (deposit/withdrawal/ledger id, or a provider id). NULL for a notice that is not about a single record.';
COMMENT ON COLUMN notifications.read_at IS
    'When the reader read it. NULL means unread. Stored per user, not per browser.';
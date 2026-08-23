-- The two keyset-pagination sort columns that were nullable.
--
-- GET /api/receipts pages on (receipt_date, created_at) and GET /api/photos on
-- (captured_at, id). Both cursors encode the boundary row's value as a string
-- and reject anything else, so a NULL in either column at a page boundary
-- would emit a cursor the next request answers with 400 — a dead end rather
-- than a skipped row. receipts.created_at defaults to now() and the photos
-- upload always sets captured_at; a pre-existing NULL fails this migration
-- rather than being rewritten.

alter table public.receipts
  alter column created_at set not null;

alter table public.photos
  alter column captured_at set not null;

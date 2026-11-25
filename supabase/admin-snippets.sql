-- Copy one snippet at a time into Supabase → SQL Editor.
-- (Or skip SQL: Supabase → Table Editor → "bids" works like a spreadsheet —
--  click "Insert row" to add a paper bid, or tick "void" to cancel one.)

-- 1) Copy paper slips from the booth table into the database.
--    One line per slip. piece_id must match the "id" in pieces.json.
insert into public.bids (piece_id, netid, amount, source) values
  ('P06', 'ab123', 300, 'booth'),
  ('R01', 'cd456',  10, 'booth');

-- 2) Current top bid on every piece
select * from public.winners order by piece_id;

-- 3) Every bid on one piece
select * from public.bids where piece_id = 'P06' order by amount desc;

-- 4) Cancel a fake / mistaken bid (it disappears from the site; the next-highest becomes top)
update public.bids set void = true where id = 123;

-- 5) Fix a typo in a bid you entered (wrong amount or NetID)
update public.bids set amount = 250, netid = 'ab123' where id = 123;

-- 6) Total raised if every winner pays
select sum(amount) as total_rmb, count(*) as pieces_with_bids from public.winners;

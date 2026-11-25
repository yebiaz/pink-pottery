-- Paper-slip bids I could read from the Nov 25 photos (top bid per ribbon only).
-- CHECK EACH LINE AGAINST THE PAPER SLIP before running — handwriting was hard to read
-- in places, and the ribbon numbers are the ones the website uses (put a number card by each ribbon).
-- Then paste into Supabase → SQL Editor → Run.

insert into public.bids (piece_id, netid, amount, source) values
  ('R14', 'mw583',  10, 'booth'),
  ('R15', 'av325',  30, 'booth'),
  ('R18', 'crh101', 20, 'booth'),   -- slip also had mn335 ¥10
  ('R20', 'aj417',  10, 'booth'),
  ('R22', 'ty141',  10, 'booth'),   -- slip also had fa143 ¥2
  ('R25', 'zm111',   5, 'booth'),
  ('R27', 'ad684',   6, 'booth'),   -- slip also had fl139 ¥5
  ('R28', 'srs160', 11, 'booth'),
  ('R29', '9p904',   5, 'booth');   -- NetID unclear (9p904? qp904?)

-- Couldn't read, please add by hand:
--   R12  cream ribbon       — NetID/amount unclear (Ta2146?)
--   R13  red/pink ribbon    — m173 and ej162, amounts unclear
--   R19  red ribbon         — m173, amount unclear
--   R21  cream ribbon       — "?214", ¥10
--   R26  olive/blue ribbon  — uf5, amount unclear
--   Slip with srs160 ¥5 / im132 ¥10 / ms1259 ¥15 — couldn't tell which piece it belongs to
--   Any bids on the larger pieces (none were visible in the photos)

-- =====================================================================
-- Pink Pottery Silent Donation — database setup
-- Paste this whole file into Supabase → SQL Editor → "Run". Safe to re-run.
-- =====================================================================

create table if not exists public.bids (
  id          bigint generated always as identity primary key,
  piece_id    text        not null check (piece_id ~ '^[A-Za-z0-9_-]{1,20}$'),
  netid       text        not null check (netid ~ '^[a-z0-9]{2,16}$'),
  amount      integer     not null check (amount between 1 and 10000),
  source      text        not null default 'web',   -- 'web' or 'booth' (paper slips)
  void        boolean     not null default false,   -- set true to cancel a fake/troll bid
  created_at  timestamptz not null default now()
);
create index if not exists bids_piece_amount_idx on public.bids (piece_id, amount desc);
create index if not exists bids_netid_idx on public.bids (netid);

-- Lock the raw table: the public can't read NetIDs or write directly.
alter table public.bids enable row level security;
revoke all on public.bids from anon, authenticated;

-- If an older version of this table had a "name" column, drop it (we no longer collect names).
alter table public.bids drop column if exists name cascade;

-- What the website is allowed to see: masked NetID only.
drop view if exists public.public_bids;
create view public.public_bids as
select
  id,
  piece_id,
  amount,
  created_at,
  left(netid, 2) || repeat('•', greatest(char_length(netid) - 2, 1))   as netid_masked
from public.bids
where not void;
grant select on public.public_bids to anon, authenticated;

-- The ONLY way to place a bid. Enforces the deadline and "must beat the top bid"
-- on the server, so nobody can get around it from the browser.
drop function if exists public.place_bid(text, text, text, integer);
create or replace function public.place_bid(
  p_piece_id text, p_netid text, p_amount integer
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deadline constant timestamptz := '2026-11-30 00:00:00+08';  -- Sunday Nov 29, midnight (China time)
  v_netid text := split_part(lower(trim(coalesce(p_netid, ''))), '@', 1);
  v_top   integer;
  v_recent integer;
begin
  if now() >= v_deadline then
    raise exception 'Bidding has closed — thank you for supporting the cause!';
  end if;
  if p_piece_id is null or p_piece_id !~ '^[A-Za-z0-9_-]{1,20}$' then
    raise exception 'Unknown piece.';
  end if;
  if v_netid !~ '^[a-z0-9]{2,16}$' then
    raise exception 'Please enter a valid NetID (letters and numbers only, e.g. ab123).';
  end if;
  if p_amount is null or p_amount < 1 or p_amount > 10000 then
    raise exception 'Bids must be a whole number between ¥1 and ¥10,000.';
  end if;

  -- light anti-spam: max 30 bids per NetID per hour
  select count(*) into v_recent from bids
   where netid = v_netid and created_at > now() - interval '1 hour';
  if v_recent >= 30 then
    raise exception 'Too many bids from this NetID in the last hour — please try again later.';
  end if;

  -- one bid at a time per piece, so two people can't both "win" the same amount
  perform pg_advisory_xact_lock(hashtext(p_piece_id));

  select max(amount) into v_top from bids where piece_id = p_piece_id and not void;
  if v_top is not null and p_amount <= v_top then
    raise exception 'Someone has already bid ¥% on this piece — your bid must be at least ¥%.', v_top, v_top + 1;
  end if;

  insert into bids (piece_id, netid, amount) values (p_piece_id, v_netid, p_amount);
  return json_build_object('ok', true, 'piece_id', p_piece_id, 'amount', p_amount);
end;
$$;

revoke all on function public.place_bid(text, text, integer) from public;
grant execute on function public.place_bid(text, text, integer) to anon, authenticated;

-- Handy for organizers (only visible in the Supabase dashboard, not to the public):
drop view if exists public.winners;
create view public.winners as
select distinct on (piece_id)
  piece_id, amount, netid, netid || '@duke.edu' as email, source, created_at
from public.bids
where not void
order by piece_id, amount desc, created_at asc;
revoke all on public.winners from anon, authenticated;

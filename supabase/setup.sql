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
-- secret token given only to the browser that placed the bid, so only it can undo the bid
alter table public.bids add column if not exists undo_token uuid not null default gen_random_uuid();

-- Lock the raw table: the public can't read NetIDs or write directly.
alter table public.bids enable row level security;
revoke all on public.bids from anon, authenticated;

-- If an older version of this table had a "name" column, drop it (we no longer collect names).
alter table public.bids drop column if exists name cascade;

-- 1) Who has proved they own their NetID
create table if not exists public.verified_netids (
  netid       text primary key check (netid ~ '^[a-z0-9]{2,16}$'),
  verified_at timestamptz not null default now(),
  how         text not null default 'email'   -- 'email', 'existing' (bid before verification existed), 'booth'
);
alter table public.verified_netids enable row level security;
revoke all on public.verified_netids from anon, authenticated;

-- people who already bid don't need to verify
insert into public.verified_netids (netid, how)
select distinct netid, 'existing' from public.bids
on conflict (netid) do nothing;

-- 2) Bids waiting for their email link
alter table public.bids add column if not exists pending boolean not null default false;

-- paper-slip bids typed in by organizers count as verified
create or replace function public.verify_booth_netid() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.source = 'booth' then
    insert into verified_netids (netid, how) values (new.netid, 'booth') on conflict (netid) do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists bids_verify_booth on public.bids;
create trigger bids_verify_booth after insert on public.bids
for each row execute function public.verify_booth_netid();

-- 3) What the website sees: pending bids stay hidden
drop view if exists public.public_bids;
create view public.public_bids as
select
  id,
  piece_id,
  amount,
  created_at,
  left(netid, 2) || repeat('•', greatest(char_length(netid) - 2, 1))   as netid_masked
from public.bids
where not void and not pending;
grant select on public.public_bids to anon, authenticated;

-- 4) Placing a bid
create or replace function public.place_bid(
  p_piece_id text, p_netid text, p_amount integer
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deadline constant timestamptz := '2026-11-29 19:00:00+08';  -- Sunday Nov 29, 7 PM (China time)
  v_netid text := split_part(lower(trim(coalesce(p_netid, ''))), '@', 1);
  v_top   integer;
  v_recent integer;
  v_id bigint;
  v_token uuid;
  v_pending boolean;
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

  select max(amount) into v_top from bids where piece_id = p_piece_id and not void and not pending;
  if v_top is not null and p_amount <= v_top then
    raise exception 'Someone has already bid ¥% on this piece — your bid must be at least ¥%.', v_top, v_top + 1;
  end if;

  v_pending := not exists (select 1 from verified_netids where netid = v_netid);

  insert into bids (piece_id, netid, amount, pending) values (p_piece_id, v_netid, p_amount, v_pending)
  returning id, undo_token into v_id, v_token;
  return json_build_object('ok', true, 'piece_id', p_piece_id, 'amount', p_amount,
                           'id', v_id, 'undo_token', v_token, 'pending', v_pending, 'netid', v_netid);
end;
$$;
revoke all on function public.place_bid(text, text, integer) from public;
grant execute on function public.place_bid(text, text, integer) to anon, authenticated;

-- 5) Called by the website after someone clicks their email link (they are logged in as netid@duke.edu)
create or replace function public.confirm_netid()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deadline constant timestamptz := '2026-11-29 19:00:00+08';
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_netid text;
  v_top   integer;
  b record;
  v_live  json[] := '{}';
  v_lost  json[] := '{}';
begin
  if v_email !~ '^[a-z0-9]{2,16}@duke\.edu$' then
    raise exception 'Please use the link sent to your Duke email.';
  end if;
  v_netid := split_part(v_email, '@', 1);
  insert into verified_netids (netid, how) values (v_netid, 'email') on conflict (netid) do nothing;

  for b in select * from bids where netid = v_netid and pending and not void order by created_at loop
    perform pg_advisory_xact_lock(hashtext(b.piece_id));
    select max(amount) into v_top from bids where piece_id = b.piece_id and not void and not pending;
    if now() < v_deadline and (v_top is null or b.amount > v_top) then
      update bids set pending = false where id = b.id;
      v_live := v_live || json_build_object('piece_id', b.piece_id, 'amount', b.amount);
    else
      update bids set void = true where id = b.id;
      v_lost := v_lost || json_build_object('piece_id', b.piece_id, 'amount', b.amount, 'top', v_top);
    end if;
  end loop;
  return json_build_object('ok', true, 'netid', v_netid, 'live', to_json(v_live), 'outbid', to_json(v_lost));
end;
$$;
revoke all on function public.confirm_netid() from public, anon;
grant execute on function public.confirm_netid() to authenticated;

-- 6) Undo (same as before, new deadline)
create or replace function public.undo_bid(p_id bigint, p_token uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deadline constant timestamptz := '2026-11-29 19:00:00+08';
  v_n integer;
begin
  if now() >= v_deadline then
    raise exception 'Bidding has closed, so bids can no longer be undone.';
  end if;
  update bids set void = true
   where id = p_id and undo_token = p_token and not void
     and created_at > now() - interval '5 minutes';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'This bid cannot be undone anymore (more than 5 minutes have passed, or it was already undone). Please message the organizers.';
  end if;
  return json_build_object('ok', true);
end;
$$;
revoke all on function public.undo_bid(bigint, uuid) from public;
grant execute on function public.undo_bid(bigint, uuid) to anon, authenticated;

-- 7) Organizer view (dashboard only): pending bids never win
drop view if exists public.winners;
create view public.winners as
select distinct on (piece_id)
  piece_id, amount, netid, netid || '@duke.edu' as email, source, created_at
from public.bids
where not void and not pending
order by piece_id, amount desc, created_at asc;
revoke all on public.winners from anon, authenticated;

-- 8) "My bids" by NetID
create or replace function public.my_bids(p_netid text)
returns table (piece_id text, amount integer, pending boolean)
language sql
stable
security definer
set search_path = public
as $$
  select b.piece_id, max(b.amount)::integer, bool_and(b.pending)
  from bids b
  where b.netid = split_part(lower(trim(coalesce(p_netid, ''))), '@', 1)
    and not b.void
  group by b.piece_id
$$;
revoke all on function public.my_bids(text) from public;
grant execute on function public.my_bids(text) to anon, authenticated;

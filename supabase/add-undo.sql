-- Run this once in Supabase → SQL Editor to add the Undo button. Safe to run more than once.

alter table public.bids add column if not exists undo_token uuid not null default gen_random_uuid();

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
  v_id bigint;
  v_token uuid;
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

  insert into bids (piece_id, netid, amount) values (p_piece_id, v_netid, p_amount)
  returning id, undo_token into v_id, v_token;
  return json_build_object('ok', true, 'piece_id', p_piece_id, 'amount', p_amount, 'id', v_id, 'undo_token', v_token);
end;
$$;

revoke all on function public.place_bid(text, text, integer) from public;
grant execute on function public.place_bid(text, text, integer) to anon, authenticated;

-- Undo a mistaken bid: only within 5 minutes, only before the deadline,
-- and only with the secret token that was returned to the bidder's own browser.
create or replace function public.undo_bid(p_id bigint, p_token uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deadline constant timestamptz := '2026-11-30 00:00:00+08';
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


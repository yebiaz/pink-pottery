-- "My bids" by NetID: lets the website show someone's bids on any device after they type their NetID.
-- Paste into Supabase → SQL Editor → Run. Safe to run more than once.
-- Shows only what the public page already shows per piece (amounts), plus which pieces that NetID bid on.

alter table public.bids add column if not exists pending boolean not null default false;

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

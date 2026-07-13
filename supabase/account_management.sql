-- fabu v1.0.1 — account management (change password, delete account).
-- Run this once in the Supabase SQL editor (project utyhyjeqzrqbnszljmdh).
-- Safe to re-run: uses create-or-replace and idempotent grants.

-- Change password: verify the current password, then set a new one.
-- Returns 'ok' | 'bad' (wrong current password / no such user) | 'weakpass'.
create or replace function public.fabu_change_password(u text, oldp text, newp text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare stored text; uname text := lower(trim(u));
begin
  select pass into stored from public.accounts where username = uname;
  if stored is null then return 'bad'; end if;
  if stored <> crypt(oldp, stored) then return 'bad'; end if;
  if length(newp) < 4 then return 'weakpass'; end if;
  update public.accounts set pass = crypt(newp, gen_salt('bf')) where username = uname;
  return 'ok';
end; $$;

-- Delete account: verify the password, then remove the row.
-- Returns true on success, false if the password is wrong / no such user.
create or replace function public.fabu_delete_account(u text, p text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare stored text; uname text := lower(trim(u));
begin
  select pass into stored from public.accounts where username = uname;
  if stored is null then return false; end if;
  if stored <> crypt(p, stored) then return false; end if;
  delete from public.accounts where username = uname;
  return true;
end; $$;

revoke all on function public.fabu_change_password(text, text, text) from public;
revoke all on function public.fabu_delete_account(text, text) from public;
grant execute on function public.fabu_change_password(text, text, text) to anon, authenticated;
grant execute on function public.fabu_delete_account(text, text) to anon, authenticated;

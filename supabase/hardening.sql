-- brute force + limits + feedback box. replaces fabu_login, same signature

create extension if not exists pgcrypto;

-- ---------- brute force ----------

create table if not exists public.fabu_login_guard (
  username   text primary key,
  fails      int not null default 0,
  first_fail timestamptz not null default now(),
  last_fail  timestamptz not null default now()
);

create or replace function public.fabu_login_wait(uname text)
returns int language plpgsql security definer set search_path = public, extensions as $$
declare g record; wait int;
begin
  select * into g from public.fabu_login_guard where username = uname;
  if g is null then return 0; end if;
  if g.last_fail < now() - interval '15 minutes' then
    delete from public.fabu_login_guard where username = uname;
    return 0;
  end if;
  if g.fails < 5 then return 0; end if;
  wait := least(300, 5 * power(2, least(g.fails - 5, 8))::int);
  if g.last_fail + (wait || ' seconds')::interval > now() then
    return ceil(extract(epoch from (g.last_fail + (wait || ' seconds')::interval - now())))::int;
  end if;
  return 0;
end; $$;

create or replace function public.fabu_login(u text, p text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare stored text; uname text := lower(trim(u));
begin
  if uname is null or length(uname) = 0 or length(uname) > 40 then return false; end if;
  if p is null or length(p) > 200 then return false; end if;     -- nothing to gain from a longer one
  if public.fabu_login_wait(uname) > 0 then return false; end if;

  select pass into stored from public.accounts where username = uname;
  if stored is not null and stored = crypt(p, stored) then
    delete from public.fabu_login_guard where username = uname;   -- a good password clears it
    return true;
  end if;

  insert into public.fabu_login_guard (username, fails)
  values (uname, 1)
  on conflict (username) do update
    set fails = public.fabu_login_guard.fails + 1, last_fail = now();
  return false;
end; $$;

create or replace function public.fabu_login_cooldown(u text)
returns int language plpgsql security definer set search_path = public, extensions as $$
begin
  return public.fabu_login_wait(lower(trim(u)));
end; $$;

create or replace function public.fabu_change_password(u text, oldp text, newp text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare stored text; uname text := lower(trim(u));
begin
  if public.fabu_login_wait(uname) > 0 then return 'bad'; end if;
  if newp is null or length(newp) > 200 then return 'weakpass'; end if;
  select pass into stored from public.accounts where username = uname;
  if stored is null or stored <> crypt(oldp, stored) then
    insert into public.fabu_login_guard (username, fails) values (uname, 1)
    on conflict (username) do update
      set fails = public.fabu_login_guard.fails + 1, last_fail = now();
    return 'bad';
  end if;
  if length(newp) < 4 then return 'weakpass'; end if;
  update public.accounts set pass = crypt(newp, gen_salt('bf')) where username = uname;
  delete from public.fabu_login_guard where username = uname;
  return 'ok';
end; $$;

create or replace function public.fabu_delete_account(u text, p text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare stored text; uname text := lower(trim(u));
begin
  if public.fabu_login_wait(uname) > 0 then return false; end if;
  select pass into stored from public.accounts where username = uname;
  if stored is null or stored <> crypt(p, stored) then
    insert into public.fabu_login_guard (username, fails) values (uname, 1)
    on conflict (username) do update
      set fails = public.fabu_login_guard.fails + 1, last_fail = now();
    return false;
  end if;
  delete from public.fabu_tokens where username = uname;
  delete from public.fabu_login_guard where username = uname;
  delete from public.accounts where username = uname;
  return true;
end; $$;

create or replace function public.fabu_token_new(u text, p text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare stored text; uname text := lower(trim(u)); t text; n int;
begin
  if public.fabu_login_wait(uname) > 0 then return null; end if;
  if p is null or length(p) > 200 then return null; end if;
  select pass into stored from public.accounts where username = uname;
  if stored is null or stored <> crypt(p, stored) then
    insert into public.fabu_login_guard (username, fails) values (uname, 1)
    on conflict (username) do update
      set fails = public.fabu_login_guard.fails + 1, last_fail = now();
    return null;
  end if;
  delete from public.fabu_login_guard where username = uname;
  delete from public.fabu_tokens where last_used < now() - interval '90 days';
  select count(*) into n from public.fabu_tokens where username = uname;
  if n > 20 then
    delete from public.fabu_tokens where token in (
      select token from public.fabu_tokens where username = uname
      order by last_used asc limit greatest(1, n - 10));
  end if;
  t := encode(gen_random_bytes(24), 'hex');
  insert into public.fabu_tokens (token, username) values (t, uname);
  insert into public.fabu_profiles (username) values (uname) on conflict do nothing;
  return t;
end; $$;

-- ---------- abuse limits ----------

create or replace function public.fabu_follow(t text, who text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.fabu_who(t); target text := lower(trim(who)); n int;
begin
  if me is null or target is null or me = target then return false; end if;
  if length(target) > 40 then return false; end if;
  if not exists (select 1 from public.accounts where username = target) then return false; end if;
  if exists (select 1 from public.fabu_follows where follower = me and followee = target) then
    delete from public.fabu_follows where follower = me and followee = target;
    return false;
  end if;
  select count(*) into n from public.fabu_follows where follower = me;
  if n >= 2000 then return false; end if;
  select count(*) into n from public.fabu_follows
   where follower = me and since > now() - interval '1 hour';
  if n >= 120 then return false; end if;
  insert into public.fabu_profiles (username) values (target) on conflict do nothing;
  insert into public.fabu_follows (follower, followee) values (me, target) on conflict do nothing;
  return true;
end; $$;

create or replace function public.fabu_loop_report(t text, lid bigint, why text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare uname text := public.fabu_who(t); n int;
begin
  if uname is null then return false; end if;
  select count(*) into n from public.fabu_reports
   where reporter = uname and ts > now() - interval '1 hour';
  if n >= 40 then return false; end if;
  insert into public.fabu_reports (loop_id, reporter, reason)
  values (lid, uname, coalesce(left(why, 200), '')) on conflict do nothing;
  select count(*) into n from public.fabu_reports where loop_id = lid;
  update public.fabu_loops set reports = n, hidden = (n >= 3) where id = lid;
  return true;
end; $$;

create or replace function public.fabu_profile_set(t text, bio_in text, accent_in text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare uname text := public.fabu_who(t);
begin
  if uname is null then return false; end if;
  insert into public.fabu_profiles (username, bio, accent)
  values (uname, coalesce(left(bio_in, 200), ''), coalesce(left(accent_in, 16), ''))
  on conflict (username) do update
    set bio = coalesce(left(bio_in, 200), ''), accent = coalesce(left(accent_in, 16), '');
  return true;
end; $$;

-- ---------- feedback ----------

create table if not exists public.fabu_feedback (
  id         bigserial primary key,
  message    text not null,
  contact    text not null default '',
  username   text not null default '',
  app        text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists fabu_feedback_recent on public.fabu_feedback (created_at desc);
alter table public.fabu_feedback enable row level security;
alter table public.fabu_login_guard enable row level security;

create or replace function public.fabu_feedback_send(msg text, contact text, who text, app text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  if msg is null or length(trim(msg)) = 0 then return false; end if;
  if length(msg) > 4000 then return false; end if;
  select count(*) into n from public.fabu_feedback where created_at > now() - interval '1 hour';
  if n >= 200 then return false; end if;                    -- the whole table, as a backstop
  insert into public.fabu_feedback (message, contact, username, app)
  values (left(msg, 4000), coalesce(left(contact, 200), ''),
          coalesce(left(who, 40), ''), coalesce(left(app, 40), ''));
  return true;
end; $$;

-- ---------- grants ----------
revoke all on function public.fabu_login_wait(text) from public, anon, authenticated;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.fabu_login(text, text)',
    'public.fabu_login_cooldown(text)',
    'public.fabu_change_password(text, text, text)',
    'public.fabu_delete_account(text, text)',
    'public.fabu_token_new(text, text)',
    'public.fabu_follow(text, text)',
    'public.fabu_loop_report(text, bigint, text)',
    'public.fabu_profile_set(text, text, text)',
    'public.fabu_feedback_send(text, text, text, text)'
  ] loop
    execute 'revoke all on function ' || fn || ' from public';
    execute 'grant execute on function ' || fn || ' to anon, authenticated';
  end loop;
end $$;

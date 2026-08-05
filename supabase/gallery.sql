-- fabu: the loop gallery, profiles and friends.
-- Run this once in the Supabase SQL editor (project utyhyjeqzrqbnszljmdh).
-- Safe to re-run: every statement is idempotent.
--
-- On storage, which was the open question: a shared loop is a recipe, not a
-- recording. It stores notes, an instrument name and a length, so a typical
-- one is a few hundred bytes. A hundred thousand of them is about 33 MB, well
-- inside the free tier. Audio would not be, which is why nothing here accepts
-- audio: the 64 KB cap in fabu_loop_publish is enforced in the database, not
-- left to the client to respect.
--
-- Every function here is security definer and every table is closed to direct
-- access, so the anon key can only do the specific things these functions do.
-- Writes are authenticated by a token from fabu_token_new, never by a password
-- sent along with each action.

create extension if not exists pgcrypto;

-- ---------- tables ----------

create table if not exists public.fabu_tokens (
  token      text primary key,
  username   text not null,
  created_at timestamptz not null default now(),
  last_used  timestamptz not null default now()
);
create index if not exists fabu_tokens_user on public.fabu_tokens (username);

create table if not exists public.fabu_profiles (
  username   text primary key,
  bio        text not null default '',
  accent     text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.fabu_loops (
  id         bigserial primary key,
  author     text not null,
  name       text not null,
  category   text not null default 'melodic',
  bpm        int  not null default 120,
  data       text not null,              -- a .fabloop payload, capped below
  likes      int  not null default 0,
  plays      int  not null default 0,
  reports    int  not null default 0,
  hidden     boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists fabu_loops_author  on public.fabu_loops (author);
create index if not exists fabu_loops_recent  on public.fabu_loops (created_at desc);
create index if not exists fabu_loops_popular on public.fabu_loops (likes desc);
create index if not exists fabu_loops_cat     on public.fabu_loops (category);

create table if not exists public.fabu_likes (
  loop_id  bigint not null references public.fabu_loops(id) on delete cascade,
  username text not null,
  primary key (loop_id, username)
);

-- One row per direction. Both directions present means the friendship is
-- mutual, which is the only state the app calls "friends".
create table if not exists public.fabu_follows (
  follower text not null,
  followee text not null,
  since    timestamptz not null default now(),
  primary key (follower, followee)
);

create table if not exists public.fabu_reports (
  loop_id  bigint not null references public.fabu_loops(id) on delete cascade,
  reporter text not null,
  reason   text not null default '',
  ts       timestamptz not null default now(),
  primary key (loop_id, reporter)
);

-- Nothing reaches these tables except through the functions below.
alter table public.fabu_tokens   enable row level security;
alter table public.fabu_profiles enable row level security;
alter table public.fabu_loops    enable row level security;
alter table public.fabu_likes    enable row level security;
alter table public.fabu_follows  enable row level security;
alter table public.fabu_reports  enable row level security;

-- ---------- helpers ----------

-- Who does this token belong to? Also refreshes last_used, so an account that
-- is in use keeps its token. Returns null for an unknown or expired token.
create or replace function public.fabu_who(t text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare uname text;
begin
  select username into uname from public.fabu_tokens
   where token = t and last_used > now() - interval '90 days';
  if uname is null then return null; end if;
  update public.fabu_tokens set last_used = now() where token = t;
  return uname;
end; $$;

-- Trade a password for a token, once, at sign-in. Everything else uses the
-- token, so a password is never attached to an ordinary action.
create or replace function public.fabu_token_new(u text, p text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare stored text; uname text := lower(trim(u)); t text;
begin
  select pass into stored from public.accounts where username = uname;
  if stored is null then return null; end if;
  if stored <> crypt(p, stored) then return null; end if;
  delete from public.fabu_tokens where last_used < now() - interval '90 days';
  t := encode(gen_random_bytes(24), 'hex');
  insert into public.fabu_tokens (token, username) values (t, uname);
  insert into public.fabu_profiles (username) values (uname) on conflict do nothing;
  return t;
end; $$;

create or replace function public.fabu_token_drop(t text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
begin
  delete from public.fabu_tokens where token = t;
  return true;
end; $$;

-- ---------- loops ----------

-- Publish a loop. Returns the new id, or a negative code:
--   -1 not signed in   -2 too large   -3 daily limit reached   -4 bad name
create or replace function public.fabu_loop_publish(t text, nm text, cat text, tempo int, payload text)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare uname text := public.fabu_who(t); today int; newid bigint;
begin
  if uname is null then return -1; end if;
  -- 64 KB is roughly two hundred times a normal loop. Anything near it is not
  -- a loop, and audio cannot fit at all, which is the point.
  if payload is null or length(payload) > 65536 then return -2; end if;
  if nm is null or length(trim(nm)) = 0 or length(nm) > 40 then return -4; end if;
  select count(*) into today from public.fabu_loops
   where author = uname and created_at > now() - interval '1 day';
  if today >= 30 then return -3; end if;
  insert into public.fabu_loops (author, name, category, bpm, data)
  values (uname, trim(nm), coalesce(nullif(trim(cat), ''), 'melodic'),
          greatest(20, least(300, coalesce(tempo, 120))), payload)
  returning id into newid;
  return newid;
end; $$;

-- Browse. sort_by is 'new' | 'top' | 'friends'. A null/empty category is all
-- of them. Hidden loops never appear.
create or replace function public.fabu_loop_list(t text, cat text, sort_by text, q text, lim int, off int)
returns table (id bigint, author text, name text, category text, bpm int,
               likes int, plays int, created_at timestamptz, liked boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare uname text := public.fabu_who(t);
begin
  return query
  select l.id, l.author, l.name, l.category, l.bpm, l.likes, l.plays, l.created_at,
         (uname is not null and exists (select 1 from public.fabu_likes k
                                         where k.loop_id = l.id and k.username = uname)) as liked
    from public.fabu_loops l
   where not l.hidden
     and (cat is null or cat = '' or l.category = cat)
     and (q is null or q = '' or l.name ilike '%' || q || '%' or l.author ilike '%' || q || '%')
     and (sort_by <> 'friends' or (uname is not null and exists (
           select 1 from public.fabu_follows f
            where f.follower = uname and f.followee = l.author)))
   order by case when sort_by = 'top' then l.likes end desc nulls last,
            l.created_at desc
   limit greatest(1, least(60, coalesce(lim, 24)))
  offset greatest(0, coalesce(off, 0));
end; $$;

-- Fetch one loop's payload, and count the play.
create or replace function public.fabu_loop_get(lid bigint)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare d text;
begin
  select data into d from public.fabu_loops where id = lid and not hidden;
  if d is null then return null; end if;
  update public.fabu_loops set plays = plays + 1 where id = lid;
  return d;
end; $$;

-- Like, or take the like back. Returns the new like count, or -1 unsigned-in.
create or replace function public.fabu_loop_like(t text, lid bigint)
returns int language plpgsql security definer set search_path = public, extensions as $$
declare uname text := public.fabu_who(t); n int;
begin
  if uname is null then return -1; end if;
  if exists (select 1 from public.fabu_likes where loop_id = lid and username = uname) then
    delete from public.fabu_likes where loop_id = lid and username = uname;
    update public.fabu_loops set likes = greatest(0, likes - 1) where id = lid;
  else
    insert into public.fabu_likes (loop_id, username) values (lid, uname) on conflict do nothing;
    update public.fabu_loops set likes = likes + 1 where id = lid;
  end if;
  select likes into n from public.fabu_loops where id = lid;
  return coalesce(n, 0);
end; $$;

create or replace function public.fabu_loop_delete(t text, lid bigint)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare uname text := public.fabu_who(t);
begin
  if uname is null then return false; end if;
  delete from public.fabu_loops where id = lid and author = uname;
  return found;
end; $$;

-- Report a loop. Enough distinct reporters and it hides itself: with no
-- moderator awake at 3am, the room has to be able to take out its own rubbish.
-- Hiding is reversible and hides nothing permanently.
create or replace function public.fabu_loop_report(t text, lid bigint, why text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare uname text := public.fabu_who(t); n int;
begin
  if uname is null then return false; end if;
  insert into public.fabu_reports (loop_id, reporter, reason)
  values (lid, uname, coalesce(left(why, 200), '')) on conflict do nothing;
  select count(*) into n from public.fabu_reports where loop_id = lid;
  update public.fabu_loops set reports = n, hidden = (n >= 3) where id = lid;
  return true;
end; $$;

-- ---------- profiles and friends ----------

create or replace function public.fabu_profile_get(t text, who text)
returns table (username text, bio text, accent text, created_at timestamptz,
               loops int, likes int, followers int, following int, i_follow boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.fabu_who(t); target text := lower(trim(who));
begin
  return query
  select p.username, p.bio, p.accent, p.created_at,
         (select count(*)::int from public.fabu_loops l where l.author = p.username and not l.hidden),
         (select coalesce(sum(l.likes), 0)::int from public.fabu_loops l where l.author = p.username and not l.hidden),
         (select count(*)::int from public.fabu_follows f where f.followee = p.username),
         (select count(*)::int from public.fabu_follows f where f.follower = p.username),
         (me is not null and exists (select 1 from public.fabu_follows f
                                      where f.follower = me and f.followee = p.username))
    from public.fabu_profiles p where p.username = target;
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

-- Follow or unfollow. Returns true if we now follow them.
create or replace function public.fabu_follow(t text, who text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.fabu_who(t); target text := lower(trim(who));
begin
  if me is null or target is null or me = target then return false; end if;
  if not exists (select 1 from public.accounts where username = target) then return false; end if;
  if exists (select 1 from public.fabu_follows where follower = me and followee = target) then
    delete from public.fabu_follows where follower = me and followee = target;
    return false;
  end if;
  insert into public.fabu_profiles (username) values (target) on conflict do nothing;
  insert into public.fabu_follows (follower, followee) values (me, target) on conflict do nothing;
  return true;
end; $$;

-- Everyone this account follows, with whether they follow back. Following each
-- other both ways is what the app shows as a friend.
create or replace function public.fabu_follow_list(t text)
returns table (name text, mutual boolean, loops int)
language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.fabu_who(t);
begin
  if me is null then return; end if;
  return query
  select f.followee,
         exists (select 1 from public.fabu_follows g where g.follower = f.followee and g.followee = me),
         (select count(*)::int from public.fabu_loops l where l.author = f.followee and not l.hidden)
    from public.fabu_follows f where f.follower = me
   order by 2 desc, 1;
end; $$;

-- ---------- grants ----------
-- fabu_who is internal: it is the thing that turns a token into an identity,
-- so it is never callable from outside.
revoke all on function public.fabu_who(text) from public, anon, authenticated;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.fabu_token_new(text, text)',
    'public.fabu_token_drop(text)',
    'public.fabu_loop_publish(text, text, text, int, text)',
    'public.fabu_loop_list(text, text, text, text, int, int)',
    'public.fabu_loop_get(bigint)',
    'public.fabu_loop_like(text, bigint)',
    'public.fabu_loop_delete(text, bigint)',
    'public.fabu_loop_report(text, bigint, text)',
    'public.fabu_profile_get(text, text)',
    'public.fabu_profile_set(text, text, text)',
    'public.fabu_follow(text, text)',
    'public.fabu_follow_list(text)'
  ] loop
    execute 'revoke all on function ' || fn || ' from public';
    execute 'grant execute on function ' || fn || ' to anon, authenticated';
  end loop;
end $$;

create table if not exists public.app_metadata (
  id smallint primary key check (id = 1),
  revision bigint not null default 0,
  lock_token uuid,
  lock_until timestamptz
);

alter table public.app_metadata
  add column if not exists lock_token uuid,
  add column if not exists lock_until timestamptz;

create table if not exists public.app_records (
  collection text not null check (
    collection in (
      '__meta', '__backups',
      'products', 'posts', 'customers', 'messages', 'decisions',
      'questions', 'knowledge', 'leads', 'quotes', 'orders',
      'followups', 'jobs', 'events', 'logs', 'pages', 'groups', 'reviews'
    )
  ),
  record_id text not null,
  data jsonb not null,
  primary key (collection, record_id)
);

alter table public.app_metadata enable row level security;
alter table public.app_records enable row level security;

insert into public.app_metadata (id, revision)
values (1, 0)
on conflict (id) do nothing;

create or replace function public.acquire_app_lock(p_lock_token uuid, p_lease_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
  update public.app_metadata
  set lock_token = p_lock_token,
      lock_until = clock_timestamp() + make_interval(secs => greatest(p_lease_seconds, 1))
  where id = 1 and (lock_until is null or lock_until <= clock_timestamp());

  get diagnostics changed = row_count;
  return changed = 1;
end
$$;

create or replace function public.release_app_lock(p_lock_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
  update public.app_metadata
  set lock_token = null, lock_until = null
  where id = 1 and lock_token = p_lock_token;

  get diagnostics changed = row_count;
  return changed = 1;
end
$$;

create or replace function public.load_app_state()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'revision', m.revision,
    'records', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'collection', r.collection,
          'record_id', r.record_id,
          'data', r.data
        )
      ) filter (where r.collection is not null),
      '[]'::jsonb
    )
  )
  from public.app_metadata as m
  left join public.app_records as r on true
  where m.id = 1
  group by m.revision
$$;

create or replace function public.commit_app_state(
  p_expected_revision bigint,
  p_upserts jsonb,
  p_deletes jsonb,
  p_lock_token uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_revision bigint;
begin
  update public.app_metadata
  set revision = revision + 1
  where id = 1
    and revision = p_expected_revision
    and lock_token = p_lock_token
    and lock_until > clock_timestamp()
  returning revision into next_revision;

  if next_revision is null then
    raise exception using
      errcode = '40001',
      message = 'Application data changed; retry this request';
  end if;

  insert into public.app_records (collection, record_id, data)
  select x.collection, x.record_id, x.data
  from jsonb_to_recordset(coalesce(p_upserts, '[]'::jsonb))
    as x(collection text, record_id text, data jsonb)
  on conflict (collection, record_id)
  do update set data = excluded.data;

  delete from public.app_records as r
  using jsonb_to_recordset(coalesce(p_deletes, '[]'::jsonb))
    as x(collection text, record_id text)
  where r.collection = x.collection and r.record_id = x.record_id;

  return next_revision;
end
$$;

revoke all on function public.load_app_state() from public, anon, authenticated;
revoke all on function public.acquire_app_lock(uuid, integer) from public, anon, authenticated;
revoke all on function public.release_app_lock(uuid) from public, anon, authenticated;
revoke all on function public.commit_app_state(bigint, jsonb, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.load_app_state() to service_role;
grant execute on function public.acquire_app_lock(uuid, integer) to service_role;
grant execute on function public.release_app_lock(uuid) to service_role;
grant execute on function public.commit_app_state(bigint, jsonb, jsonb, uuid) to service_role;

insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = excluded.public;

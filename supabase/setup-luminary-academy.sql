-- =====================================================================================
-- Luminary Automation — one-time setup inside the Luminary Academy Supabase project
-- Paste this whole file into Supabase > SQL Editor > New query, then click "Run".
--
-- What it does: creates a NEW, separate section of the database called `automation`
-- and puts Luminary Automation's tables there.
-- What it does NOT do: it does not read, change or delete anything in your existing
-- Luminary Academy tables (students, enrollments, sessions, notes, ...).
-- Safe to run more than once.
-- =====================================================================================

create schema if not exists automation;

create table if not exists automation.workspaces (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text not null unique check (slug ~ '^[a-z0-9-]{3,48}$'),
  plan          text not null default 'pilot' check (plan in ('pilot','starter','growth','pro')),
  timezone      text not null default 'America/New_York',
  reply_from    text,
  reply_to      text,
  booking_link  text,
  open_days     smallint[] not null default '{1,2,3,4,5,6}',
  open_hour     smallint not null default 9 check (open_hour between 0 and 23),
  close_hour    smallint not null default 19 check (close_hour between 1 and 24),
  created_at    timestamptz not null default now()
);

create table if not exists automation.memberships (
  workspace_id  uuid not null references automation.workspaces(id) on delete cascade,
  user_id       uuid not null,
  email         text not null,
  role          text not null check (role in ('owner','staff')),
  created_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists memberships_user_idx on automation.memberships(user_id);

create table if not exists automation.member_invites (
  workspace_id  uuid not null references automation.workspaces(id) on delete cascade,
  email         text not null check (email = lower(email)),
  role          text not null check (role in ('owner','staff')),
  invited_by    uuid,
  created_at    timestamptz not null default now(),
  primary key (workspace_id, email)
);
create index if not exists member_invites_email_idx on automation.member_invites(email);

create table if not exists automation.knowledge_items (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references automation.workspaces(id) on delete cascade,
  kind          text not null check (kind in ('service','price','hours','faq','policy')),
  title         text not null,
  content       text not null,
  active        boolean not null default true,
  updated_at    timestamptz not null default now()
);
create index if not exists knowledge_ws_idx on automation.knowledge_items(workspace_id, kind);

create table if not exists automation.leads (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references automation.workspaces(id) on delete cascade,
  parent_name        text,
  student_name       text,
  email              text,
  phone              text,
  message            text not null,
  source             text not null default 'web_form',
  subject            text,
  grade_level        text,
  service            text,
  analysis           jsonb not null default '{}'::jsonb,
  stage              text not null default 'new'
                       check (stage in ('new','contacted','appointment_booked','enrolled','closed')),
  closed_reason      text,
  first_response_at  timestamptz,
  enrolled_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  search             tsvector generated always as (
                       to_tsvector('simple',
                         coalesce(parent_name,'') || ' ' || coalesce(student_name,'') || ' ' ||
                         coalesce(email,'') || ' ' || coalesce(phone,'') || ' ' ||
                         coalesce(subject,'') || ' ' || coalesce(grade_level,'') || ' ' ||
                         coalesce(service,'') || ' ' || message)) stored
);
create index if not exists leads_ws_stage_idx on automation.leads(workspace_id, stage, created_at desc);
create index if not exists leads_search_idx on automation.leads using gin(search);

create table if not exists automation.messages (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references automation.workspaces(id) on delete cascade,
  lead_id        uuid not null references automation.leads(id) on delete cascade,
  purpose        text not null check (purpose in ('first_response','follow_up','appointment_reminder','post_appointment','manual')),
  subject        text not null,
  body           text not null,
  status         text not null default 'pending_review'
                   check (status in ('pending_review','approved','sent','rejected','failed')),
  generated_by   text not null check (generated_by in ('ai','ai_simulated','template','staff')),
  missing_info   jsonb not null default '[]'::jsonb,
  flags          jsonb not null default '[]'::jsonb,
  delivery_mode  text check (delivery_mode in ('live','simulated')),
  error          text,
  reviewed_by    uuid,
  reviewed_at    timestamptz,
  sent_at        timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists messages_queue_idx on automation.messages(workspace_id, status, created_at);
create index if not exists messages_lead_idx on automation.messages(lead_id);

create table if not exists automation.appointments (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references automation.workspaces(id) on delete cascade,
  lead_id       uuid not null references automation.leads(id) on delete cascade,
  kind          text not null default 'consultation' check (kind in ('consultation','assessment','trial_session')),
  starts_at     timestamptz not null,
  status        text not null default 'scheduled' check (status in ('scheduled','completed','no_show','cancelled')),
  notes         text,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists appts_ws_idx on automation.appointments(workspace_id, starts_at);

create table if not exists automation.reminders (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references automation.workspaces(id) on delete cascade,
  lead_id         uuid not null references automation.leads(id) on delete cascade,
  appointment_id  uuid references automation.appointments(id) on delete cascade,
  kind            text not null check (kind in ('staff_respond_overdue','follow_up_1','follow_up_2','appointment_reminder','post_appointment')),
  due_at          timestamptz not null,
  status          text not null default 'pending' check (status in ('pending','processing','done','skipped','cancelled','failed')),
  dedupe_key      text not null,
  result          text,
  processed_at    timestamptz,
  created_at      timestamptz not null default now(),
  unique (workspace_id, dedupe_key)
);
create index if not exists reminders_due_idx on automation.reminders(status, due_at);

create table if not exists automation.automation_events (
  id            uuid primary key default gen_random_uuid(),
  seq           bigint generated always as identity,
  workspace_id  uuid not null references automation.workspaces(id) on delete cascade,
  lead_id       uuid references automation.leads(id) on delete set null,
  actor         text not null,
  action        text not null,
  status        text not null check (status in ('success','error','skipped')),
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists events_ws_idx on automation.automation_events(workspace_id, created_at desc);

create table if not exists automation.ai_usage (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references automation.workspaces(id) on delete cascade,
  lead_id        uuid references automation.leads(id) on delete set null,
  operation      text not null check (operation in ('analyze','draft')),
  model          text not null,
  simulated      boolean not null,
  input_tokens   integer not null default 0,
  output_tokens  integer not null default 0,
  cost_usd_est   numeric(10,6) not null default 0,
  created_at     timestamptz not null default now()
);
create index if not exists ai_usage_ws_idx on automation.ai_usage(workspace_id, created_at);

-- Row Level Security: anyone using the public Supabase key can only READ rows from
-- workspaces they belong to, and can never write. All writes go through the app's server.
create or replace function automation.is_member(ws uuid) returns boolean
  language sql stable security definer set search_path = automation, public as $$
    select exists (select 1 from automation.memberships m where m.workspace_id = ws and m.user_id = auth.uid());
  $$;

do $$
declare t text;
begin
  foreach t in array array['workspaces','memberships','member_invites','knowledge_items','leads','messages',
                           'appointments','reminders','automation_events','ai_usage'] loop
    execute format('alter table automation.%I enable row level security', t);
    execute format('drop policy if exists member_read on automation.%I', t);
    if t = 'workspaces' then
      execute 'create policy member_read on automation.workspaces for select to authenticated using (automation.is_member(id))';
    else
      execute format('create policy member_read on automation.%I for select to authenticated using (automation.is_member(workspace_id))', t);
    end if;
  end loop;
end $$;

-- Check: this should list 10 tables.
select table_name from information_schema.tables where table_schema = 'automation' order by table_name;

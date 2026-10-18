-- Luminary Automation — initial schema
-- Runs on Supabase Postgres (and on PGlite for local demo/tests, with a stub `auth.uid()`).
--
-- Security model
--   * The Express API connects with the database owner role and is the ONLY writer.
--     It enforces workspace isolation and owner/staff permissions in code (server/services).
--   * Row Level Security is ALSO enabled on every table as defense in depth: if someone
--     uses the public anon/authenticated key against Supabase's REST API directly, they
--     can only READ rows from workspaces they belong to, and cannot write anything.

-- ---------------------------------------------------------------- workspaces & members
create table if not exists workspaces (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text not null unique check (slug ~ '^[a-z0-9-]{3,48}$'),
  plan          text not null default 'pilot' check (plan in ('pilot','starter','growth','pro')),
  timezone      text not null default 'America/New_York',
  reply_from    text,                 -- display name for outgoing email
  reply_to      text,                 -- center's inbox, used as Reply-To
  booking_link  text,                 -- optional link to the center's own scheduler
  created_at    timestamptz not null default now()
);

create table if not exists memberships (
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  user_id       uuid not null,        -- = auth.users.id in Supabase
  email         text not null,
  role          text not null check (role in ('owner','staff')),
  created_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists memberships_user_idx on memberships(user_id);

-- ---------------------------------------------------------------- knowledge base
-- The ONLY facts the AI may state: services, prices, hours, FAQs, policies.
create table if not exists knowledge_items (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  kind          text not null check (kind in ('service','price','hours','faq','policy')),
  title         text not null,
  content       text not null,
  active        boolean not null default true,
  updated_at    timestamptz not null default now()
);
create index if not exists knowledge_ws_idx on knowledge_items(workspace_id, kind);

-- ---------------------------------------------------------------- leads
create table if not exists leads (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references workspaces(id) on delete cascade,
  parent_name        text,
  student_name       text,
  email              text,
  phone              text,
  message            text not null,
  source             text not null default 'web_form',
  subject            text,            -- AI-extracted
  grade_level        text,            -- AI-extracted
  service            text,            -- AI-extracted (matched to knowledge base when possible)
  analysis           jsonb not null default '{}'::jsonb,
  stage              text not null default 'new'
                       check (stage in ('new','contacted','appointment_booked','enrolled','closed')),
  closed_reason      text,
  first_response_at  timestamptz,     -- set when the first outgoing message is sent
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
create index if not exists leads_ws_stage_idx on leads(workspace_id, stage, created_at desc);
create index if not exists leads_search_idx on leads using gin(search);

-- ---------------------------------------------------------------- outgoing messages (review queue)
create table if not exists messages (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  lead_id        uuid not null references leads(id) on delete cascade,
  purpose        text not null check (purpose in ('first_response','follow_up','appointment_reminder','post_appointment','manual')),
  subject        text not null,
  body           text not null,
  status         text not null default 'pending_review'
                   check (status in ('pending_review','approved','sent','rejected','failed')),
  generated_by   text not null check (generated_by in ('ai','ai_simulated','template','staff')),
  missing_info   jsonb not null default '[]'::jsonb,   -- what the AI could not answer from the knowledge base
  flags          jsonb not null default '[]'::jsonb,   -- automated guardrail warnings (e.g. unverified price)
  delivery_mode  text check (delivery_mode in ('live','simulated')),
  error          text,
  reviewed_by    uuid,
  reviewed_at    timestamptz,
  sent_at        timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists messages_queue_idx on messages(workspace_id, status, created_at);
create index if not exists messages_lead_idx on messages(lead_id);

-- ---------------------------------------------------------------- appointments
create table if not exists appointments (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  lead_id       uuid not null references leads(id) on delete cascade,
  kind          text not null default 'consultation' check (kind in ('consultation','assessment','trial_session')),
  starts_at     timestamptz not null,
  status        text not null default 'scheduled' check (status in ('scheduled','completed','no_show','cancelled')),
  notes         text,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists appts_ws_idx on appointments(workspace_id, starts_at);

-- ---------------------------------------------------------------- reminders (programmed rules)
-- dedupe_key makes scheduling idempotent: the same reminder can never be inserted twice.
-- status transitions pending -> processing are done with a single conditional UPDATE,
-- so two workers can never both act on one reminder.
create table if not exists reminders (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  lead_id         uuid not null references leads(id) on delete cascade,
  appointment_id  uuid references appointments(id) on delete cascade,
  kind            text not null check (kind in ('staff_respond_overdue','follow_up_1','follow_up_2','appointment_reminder','post_appointment')),
  due_at          timestamptz not null,
  status          text not null default 'pending' check (status in ('pending','processing','done','skipped','cancelled','failed')),
  dedupe_key      text not null,
  result          text,
  processed_at    timestamptz,
  created_at      timestamptz not null default now(),
  unique (workspace_id, dedupe_key)
);
create index if not exists reminders_due_idx on reminders(status, due_at);

-- ---------------------------------------------------------------- audit trail
create table if not exists automation_events (
  id            uuid primary key default gen_random_uuid(),
  seq           bigint generated always as identity,   -- tiebreaker for same-timestamp ordering
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  lead_id       uuid references leads(id) on delete set null,
  actor         text not null,         -- 'system', 'ai', or a user id
  action        text not null,         -- e.g. 'lead.created', 'ai.analyze', 'message.sent'
  status        text not null check (status in ('success','error','skipped')),
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists events_ws_idx on automation_events(workspace_id, created_at desc);

-- ---------------------------------------------------------------- AI usage metering
create table if not exists ai_usage (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  lead_id        uuid references leads(id) on delete set null,
  operation      text not null check (operation in ('analyze','draft')),
  model          text not null,
  simulated      boolean not null,
  input_tokens   integer not null default 0,
  output_tokens  integer not null default 0,
  cost_usd_est   numeric(10,6) not null default 0,
  created_at     timestamptz not null default now()
);
create index if not exists ai_usage_ws_idx on ai_usage(workspace_id, created_at);

-- ---------------------------------------------------------------- Row Level Security (defense in depth)
create or replace function is_member(ws uuid) returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (select 1 from memberships m where m.workspace_id = ws and m.user_id = auth.uid());
  $$;

do $$
declare t text;
begin
  foreach t in array array['workspaces','memberships','knowledge_items','leads','messages',
                           'appointments','reminders','automation_events','ai_usage'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists member_read on %I', t);
    if t = 'workspaces' then
      execute 'create policy member_read on workspaces for select to authenticated using (is_member(id))';
    else
      execute format('create policy member_read on %I for select to authenticated using (is_member(workspace_id))', t);
    end if;
    -- No insert/update/delete policies: client keys can never write. All writes go through the API.
  end loop;
end $$;

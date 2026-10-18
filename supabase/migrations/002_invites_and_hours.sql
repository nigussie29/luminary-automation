-- 002: staff invites without the Supabase service-role key, and business hours.

-- Owners invite staff by email. When someone signs in with a verified email that has a pending
-- invite, the API turns the invite into a membership. No admin key needed.
create table if not exists member_invites (
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  email         text not null check (email = lower(email)),
  role          text not null check (role in ('owner','staff')),
  invited_by    uuid,
  created_at    timestamptz not null default now(),
  primary key (workspace_id, email)
);
create index if not exists member_invites_email_idx on member_invites(email);
alter table member_invites enable row level security;
drop policy if exists member_read on member_invites;
create policy member_read on member_invites for select to authenticated using (is_member(workspace_id));

-- Business hours: the "no reply yet" alert counts only open hours.
-- open_days uses 0 = Sunday ... 6 = Saturday, in the workspace time zone.
alter table workspaces add column if not exists open_days smallint[] not null default '{1,2,3,4,5,6}';
alter table workspaces add column if not exists open_hour smallint not null default 9 check (open_hour between 0 and 23);
alter table workspaces add column if not exists close_hour smallint not null default 19 check (close_hour between 1 and 24);

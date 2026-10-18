# Luminary Automation (working name)

**Inquiry-to-enrollment automation for tutoring centers.** A family asks about tutoring → the inquiry is recorded → AI works out the subject, grade and service → AI drafts a reply using only the center's approved services, prices, hours and FAQs → a staff member approves it → programmed rules track the appointment and schedule follow-ups so no family is forgotten.

> Business case, pricing, unit economics and the pilot plan are in [`docs/BUSINESS.md`](docs/BUSINESS.md).

---

## What's in this version (MVP scope)

| Feature | Status |
|---|---|
| Secure login, owner and staff roles | Supabase Auth (live) or demo accounts |
| Separate workspace per tutoring business | Enforced in API **and** Postgres Row Level Security |
| Public inquiry form + searchable lead list | `/f/<center-slug>`, search, stage filters |
| Lead stages: New, Contacted, Appointment Booked, Enrolled, Closed | Rule-based transitions |
| AI analysis (subject, grade, service) | Claude API (live) or rules (simulated) |
| AI reply drafts from the knowledge base only | Missing facts are listed for staff, never invented |
| Review queue — nothing sends without approval | Edit, approve & send, discard, retry failed |
| Guardrails | Blocks unapproved prices, availability promises, placeholders |
| Appointment tracking + reminders | Book, reschedule, attended, no-show, cancel |
| Follow-up reminders | Reply alert after 2 *open* hours (center's own days, hours and time zone), day-2 and day-5 follow-ups, 24h appointment reminder, next-day check-in |
| Staff invites | Owner adds an email; that person joins on first sign-in with the verified address |
| Automation history | Every step, success / skipped / error with the reason |
| Dashboard | Inquiries, median first-reply time, booked, enrolled, AI usage vs plan limit |
| Email sending | Resend (live) or simulated |
| Calendar sync | **Not in v1** — appointments are tracked in-app; optional booking link (Calendly etc.) is inserted in replies |

**Out of scope for v1:** SMS, two-way email threading (family replies go to the center's own inbox via Reply-To), Google/Outlook calendar sync, Stripe billing, multi-location reporting. See "Next steps".

### What is AI and what is programmed

| AI does | Programmed rules do |
|---|---|
| Read the inquiry: subject, grade, matched service, urgency, spam | Stage changes and which transitions are allowed |
| Draft the first reply from knowledge-base facts | When reminders are due, and whether each still applies when it fires |
| List facts it couldn't find (e.g. a missing price) | Follow-up and reminder message templates |
| | Duplicate prevention, plan limits, permission checks, guardrail checks on every outgoing message |

If AI is unavailable, over the plan limit, or returns garbage, the lead is still saved, the failure is logged, and a rules-based template draft is queued with a warning.

---

## Architecture

```
Browser (React + Vite + Tailwind)
   │  Supabase session token        public form (no login)
   ▼                                   │
Express API (Node 20+) ◄───────────────┘
   ├─ auth: verifies token, resolves workspace membership + role on every request
   ├─ services.js: all business logic; every query filtered by workspace_id
   ├─ rules.js: stages, reminder timing, plan limits (deterministic)
   ├─ ai/: Claude API calls (server-side only) + guardrails
   ├─ integrations/email.js: Resend
   └─ reminder engine: runs every minute; claims each reminder atomically
   ▼
Postgres (Supabase) — RLS on every table as a second line of defense
```

This matches your existing Luminary stack (Node/Express proxy keeping the Claude key server-side, deployed on Railway), with Supabase added for auth and Postgres.

**Why the API, not the browser, talks to the database:** the browser never holds a key that can write. The server is the only writer, checks membership and role on every request, and returns 404 for records in other workspaces. RLS still restricts any direct use of the public Supabase key to *read-only, own-workspace* rows.

---

## Database structure

`supabase/migrations/001_init.sql`

| Table | Purpose | Key columns |
|---|---|---|
| `workspaces` | One per tutoring business | `slug` (form URL), `plan`, `timezone`, `reply_from`, `reply_to`, `booking_link` |
| `memberships` | User ↔ workspace with role | `user_id`, `role` (`owner` / `staff`) |
| `knowledge_items` | The only facts AI may use | `kind` (service / price / hours / faq / policy), `title`, `content` |
| `leads` | One per inquiry/family | contact fields, `message`, AI fields (`subject`, `grade_level`, `service`, `analysis`), `stage`, `first_response_at`, `enrolled_at` |
| `messages` | Outgoing messages + review queue | `purpose`, `status` (pending_review / approved / sent / rejected / failed), `generated_by`, `missing_info`, `flags`, `delivery_mode` (live / simulated) |
| `appointments` | Consultations, assessments, trials | `starts_at`, `status` (scheduled / completed / no_show / cancelled) |
| `reminders` | Programmed follow-ups | `kind`, `due_at`, `status`, **`unique(workspace_id, dedupe_key)`** |
| `automation_events` | Audit trail | `action`, `status` (success / error / skipped), `detail` |
| `ai_usage` | Metering for limits and cost | `operation`, `model`, tokens, `cost_usd_est`, `simulated` |

### How duplicates are prevented

1. **Scheduling is idempotent.** Each reminder has a `dedupe_key` (e.g. `follow_up_1:<lead>:<message that started the cycle>`) with a unique constraint; re-scheduling is a no-op.
2. **Execution is claimed atomically.** `UPDATE … SET status='processing' WHERE id=$1 AND status='pending'` — if two workers race, only one row update succeeds.
3. **Conditions are re-checked when a reminder fires.** A follow-up is skipped if the lead has booked, enrolled or closed, or if another follow-up is already waiting for review.
4. **Sends are claimed too.** Approving moves `pending_review → approved` conditionally, so a double-click or two staff members can't send twice.
5. **Repeat inquiries join the open lead.** The same email within 7 days appends to the existing lead instead of starting a second workflow.

---

## Run it locally

Requirements: Node 20+.

```bash
npm install
npm run dev          # API on :8787, app on http://localhost:5173
```

With no `.env`, everything runs in **demo mode**: an in-process Postgres (PGlite) with two sample centers, password-free sample accounts, simulated AI and simulated email. A yellow strip at the top of every screen shows which pieces are live and which are simulated.

Try this:
1. Sign in as **Jordan (Staff, Bright Path)**. Open **Review queue**, edit a draft, and approve it.
2. Open **Open inquiry form** in the sidebar and submit an inquiry as a parent. It shows up in the queue within a second.
3. On a lead, choose **Book appointment**. Follow-ups are cancelled and an appointment reminder is scheduled.
4. Add `$40 per hour` to a draft. Sending is blocked until you remove it or acknowledge the warning.
5. Sign in as **Sam (Summit Learning)**. None of Bright Path's leads are visible.
6. On **Today**, choose **Run due reminders now** to trigger the reminder engine.

### Tests

```bash
npm test
```

30 tests run against a real Postgres engine (PGlite) and the real HTTP API:

- **Workflow:** an inquiry goes through analysis, draft, approval, Contacted, follow-up, booking, reminder, attended, and Enrolled. The dashboard and history reflect every step.
- **Duplicates:** concurrent reminder runs, re-scheduling, a follow-up already waiting, a double-clicked approve, and repeat inquiries.
- **Errors:** an AI outage (lead saved, error logged, fallback draft), an email failure followed by a retry, a lead with no email, a reminder that crashes while the others still run, and spam and invalid form input.
- **Isolation:** workspace B gets 404 on every read and write of A's records by ID and 403 with A's workspace header. Staff vs owner permissions are checked. RLS is tested as a signed-in Supabase user.
- **Guardrails:** unapproved prices, availability claims, missing-price handling, asking for a missing grade or subject, the override audit, and plan-limit fallback.
- **Live AI path:** a mocked Anthropic response, closed-list service enforcement, cost metering, and delimiting of untrusted text.
- **Go-live paths:** Supabase-verified sign-in (forged and demo tokens rejected, demo endpoints off), staff invites (only verified matching emails join; seats include pending invites), business-hours alerts across nights and weekends, and the full workflow plus migrations over the real Postgres wire protocol with the `pg` driver.

---

## Go live

### 1. Supabase
1. Create a project at supabase.com.
2. Open the **SQL Editor**, paste `supabase/migrations/001_init.sql`, and run it. Alternatively, `npm run db:migrate` runs it on every deploy.
3. Go to **Authentication → URL Configuration** and set the Site URL to your app URL. Add it under Redirect URLs as well.
4. From **Project Settings → API**, copy the URL and the anon (or publishable) key. The service-role key is not needed.
5. From **Connect**, copy the Postgres connection string (session pooler). This is your `DATABASE_URL`.

### 2. Anthropic and Resend (optional, but needed for real customers)
- Get an `ANTHROPIC_API_KEY` from console.anthropic.com. The default model is `claude-haiku-5-5`.
- In Resend, verify a sending domain (e.g. `mail.yourdomain.com`), then set `RESEND_API_KEY` and `EMAIL_FROM`. Each center's own address goes in **Settings → Replies go to**, so families' replies reach the center.

### 3. Railway
1. Push this folder to a GitHub repo.
2. In Railway, create a **New Project → Deploy from GitHub repo**. `railway.toml` already sets the build, migration-on-start, start command, and health check.
3. Add the variables from `.env.example`, and set `APP_URL` to the Railway domain or your custom domain (e.g. `app.theluminaryacademy.net`).
4. Deploy. Open `/api/status` and check that `auth`, `database`, `ai` and `email` all say `live`.

The reminder engine runs inside the web service every minute, and running more than one replica is safe. You can also have an external scheduler call `POST /api/cron/reminders` with the header `x-cron-secret: $CRON_SECRET`.

### Security checklist before the first real family
- [ ] `ANTHROPIC_API_KEY`, `RESEND_API_KEY` and `DATABASE_URL` are set only on the server, never with a `VITE_` prefix. (The Supabase service-role key is not used at all.)
- [ ] `/api/status` reports `auth: live`. Demo sign-in is impossible once Supabase is configured.
- [ ] Email confirmation is enabled in Supabase Auth.
- [ ] Each center has filled in its knowledge base (services, prices, hours) before the form goes live.
- [ ] You have a short privacy notice and a data-processing agreement for centers. Inquiries often involve minors, so collect only what you need. The form asks for the parent's contact details, not the child's.

---

## Known limitations and next steps

1. **Two-way email:** replies currently go to the center's inbox. Inbound parsing would let replies thread into the lead and mark it Contacted automatically.
2. **SMS:** many families respond faster to texts. Add Twilio, with opt-in consent.
3. **Calendar:** Google Calendar sync for appointments, plus availability-aware booking.
4. **Billing:** Stripe subscriptions mapped to `workspaces.plan`. The plan is currently set in the database.
5. **Rate limiting** is per instance, in memory. Move it to Redis or the edge when you scale.
6. **Tuning:** reminder timing and plan limits live in `server/rules.js`. Tune them with pilot data.

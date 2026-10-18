// Programmed (non-AI) business rules: lead stages, reminder timing, plan limits.
// Everything here is deterministic and unit-testable. AI never decides stage or timing.

export const STAGES = ['new', 'contacted', 'appointment_booked', 'enrolled', 'closed'];
export const STAGE_LABELS = {
  new: 'New', contacted: 'Contacted', appointment_booked: 'Appointment Booked',
  enrolled: 'Enrolled', closed: 'Closed',
};

// Allowed manual transitions. Automatic transitions use the same table.
const TRANSITIONS = {
  new: ['contacted', 'appointment_booked', 'closed'],
  contacted: ['appointment_booked', 'enrolled', 'closed'],
  appointment_booked: ['contacted', 'enrolled', 'closed'], // back to contacted after no-show/cancel
  enrolled: ['closed'],
  closed: ['new'], // reopen
};
export const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);
export const isOpenStage = (stage) => ['new', 'contacted', 'appointment_booked'].includes(stage);

// Reminder timing — ASSUMPTIONS to tune with pilot customers.
export const TIMING = {
  respondOverdueHours: 2,          // alert staff if a new inquiry has no reply after 2h
  followUp1Hours: 48,              // first nudge if no appointment 2 days after first reply
  followUp2Hours: 120,             // second (final) nudge at 5 days
  appointmentReminderHours: 24,    // reminder 24h before appointment
  appointmentReminderMinLeadHours: 2, // if booked <26h out, remind 2h before instead (if possible)
  postAppointmentHours: 24,        // check-in 1 day after appointment
  duplicateInquiryDays: 7,         // same email + open lead within 7 days = same lead
};

const H = 3600_000;

const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map();
function localDayHour(date, timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }));
  }
  const parts = formatters.get(timeZone).formatToParts(date);
  return { day: WEEKDAY[parts.find((p) => p.type === 'weekday').value], hour: Number(parts.find((p) => p.type === 'hour').value) };
}

/** Adds `hours` of OPEN time (workspace hours, in its time zone) to `start`.
 *  An inquiry at 9 pm Saturday with 2 business hours, Mon–Sat 9–19, becomes due 11 am Monday. */
export function addBusinessHours(start, hours, ws = {}) {
  const days = ws.open_days?.length ? ws.open_days.map(Number) : [0, 1, 2, 3, 4, 5, 6];
  const open = ws.open_hour ?? 0;
  const close = ws.close_hour ?? 24;
  const tz = ws.timezone || 'UTC';
  const STEP = 15 * 60_000;
  let t = new Date(start).getTime();
  let remaining = hours * H;
  for (let i = 0; i < 4 * 24 * 21 && remaining > 0; i += 1) { // look ahead at most 3 weeks
    const { day, hour } = localDayHour(new Date(t), tz);
    if (days.includes(day) && hour >= open && hour < close) remaining -= STEP;
    t += STEP;
  }
  return new Date(t);
}

/** Reminders to create when a lead is first recorded. */
export function remindersOnLeadCreated(lead, ws) {
  return [{
    kind: 'staff_respond_overdue',
    due_at: addBusinessHours(lead.created_at, TIMING.respondOverdueHours, ws),
    dedupe_key: `staff_respond_overdue:${lead.id}`,
  }];
}

/** Reminders after the lead has been contacted. `anchorId` identifies the event that started this cycle
 *  (first message id, or a cancelled appointment id), so re-running is idempotent. */
export function followUpReminders(leadId, anchorId, from) {
  const t = new Date(from).getTime();
  return [
    { kind: 'follow_up_1', due_at: new Date(t + TIMING.followUp1Hours * H), dedupe_key: `follow_up_1:${leadId}:${anchorId}` },
    { kind: 'follow_up_2', due_at: new Date(t + TIMING.followUp2Hours * H), dedupe_key: `follow_up_2:${leadId}:${anchorId}` },
  ];
}

export function appointmentReminders(appt, now) {
  const start = new Date(appt.starts_at).getTime();
  const key = `${appt.id}:${new Date(start).toISOString()}`; // a reschedule gets new keys
  const out = [];
  let remindAt = start - TIMING.appointmentReminderHours * H;
  if (remindAt <= now.getTime()) remindAt = start - TIMING.appointmentReminderMinLeadHours * H;
  if (remindAt > now.getTime()) {
    out.push({ kind: 'appointment_reminder', due_at: new Date(remindAt), dedupe_key: `appointment_reminder:${key}` });
  }
  out.push({ kind: 'post_appointment', due_at: new Date(start + TIMING.postAppointmentHours * H), dedupe_key: `post_appointment:${key}` });
  return out;
}

// Monthly plan limits — ASSUMPTIONS (see docs/BUSINESS.md). One inquiry ≈ 2 AI operations (analyze + draft).
export const PLANS = {
  pilot:   { label: 'Pilot',   price_usd: 99,  ai_ops: 400,  seats: 3,  workspaces: 1 },
  starter: { label: 'Starter', price_usd: 149, ai_ops: 400,  seats: 3,  workspaces: 1 },
  growth:  { label: 'Growth',  price_usd: 299, ai_ops: 1200, seats: 8,  workspaces: 1 },
  pro:     { label: 'Pro',     price_usd: 549, ai_ops: 4000, seats: 25, workspaces: 3 },
};

// Demo data: two tutoring centers with sample users, knowledge bases and leads.
// Leads are run through the REAL workflow (with a shifted clock) so the history, reminders
// and dashboard numbers are produced by the same code paths a customer would use.
import { DEMO_USERS } from './auth.js';
import { createServices } from './services.js';

const [MAYA, JORDAN, SAM] = DEMO_USERS;

const KB_BRIGHT = [
  ['service', '1-on-1 Tutoring', 'Private sessions matched to your student\'s school curriculum, in person or online. Grades 3-12 in math, science, reading and writing.'],
  ['service', 'SAT/ACT Prep', '12-session test-prep program with a diagnostic practice test at the start and end.'],
  ['service', 'Small Group Math Class', 'Weekly 90-minute class with up to 5 students working at the same level.'],
  ['service', 'Academic Assessment', 'A one-hour skills assessment to find gaps and recommend a plan.'],
  ['price', '1-on-1 Tutoring price', '$65 per hour; 10-hour packages are $600.'],
  ['price', 'SAT/ACT Prep price', '$1,200 for the 12-session program.'],
  ['price', 'Small Group Math Class price', '$240 per month.'],
  ['hours', 'Center hours', 'Monday-Thursday 3:00-8:00 pm and Saturday 9:00 am-2:00 pm (Eastern).'],
  ['faq', 'Online sessions', 'Yes. Any 1-on-1 session can be held online over Zoom.'],
  ['policy', 'Cancellation policy', 'Please give 24 hours notice to reschedule a session without charge.'],
];
const KB_SUMMIT = [
  ['service', 'Homework Help', 'Drop-in homework support for grades 1-8.'],
  ['price', 'Homework Help price', '$180 per month for up to 3 visits per week.'],
  ['hours', 'Center hours', 'Monday-Friday 2:30-6:30 pm (Pacific).'],
];

const SAMPLES_BRIGHT = [
  { daysAgo: 12, parent_name: 'Lena Ortiz', student_name: 'Mateo', email: 'lena.ortiz@example.com', message: 'My son Mateo is in 8th grade and struggling with algebra. Do you offer one-on-one tutoring after school?', path: ['approve', 'book', 'complete', 'enroll'] },
  { daysAgo: 9, parent_name: 'David Chen', student_name: 'Ava', email: 'dchen@example.com', message: 'Looking for SAT prep for my daughter, she is a junior. Test is in March.', path: ['approve', 'book'] },
  { daysAgo: 6, parent_name: 'Priya Natarajan', student_name: 'Rohan', email: 'priya.n@example.com', message: 'Hi, my 5th grader needs help with reading comprehension. What are your hours?', path: ['approve'] },
  { daysAgo: 4, parent_name: 'Tom Becker', student_name: '', email: 'tbecker@example.com', message: 'Do you do an academic assessment? Not sure where my kid stands in math.', path: ['approve', 'close'] },
  { daysAgo: 0.2, parent_name: 'Grace Mensah', student_name: 'Kofi', email: 'grace.mensah@example.com', message: 'My daughter is in 10th grade chemistry and has a big exam next week. Can someone help ASAP?', path: [] },
  { daysAgo: 0.05, parent_name: 'Alex Rivera', student_name: '', email: 'alex.r@example.com', message: 'Hello, interested in tutoring. What do you offer?', path: [] },
];

export async function seedDemo({ db, ai, email, identity }) {
  const existing = await db.query(`select id from workspaces where slug = 'bright-path'`);
  if (existing.length) return;
  let t = null;
  const clock = () => (t ? new Date(t) : new Date());
  const svc = createServices({ db, ai, email, identity, clock });

  const mk = async (name, slug, plan, tz, owner, kb, extra = {}) => {
    const [ws] = await db.query(`insert into workspaces (name, slug, plan, timezone, reply_from, reply_to, booking_link)
                                 values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [name, slug, plan, tz, extra.reply_from || name, extra.reply_to || null, extra.booking_link || null]);
    await db.query(`insert into memberships (workspace_id, user_id, email, role) values ($1,$2,$3,'owner')`, [ws.id, owner.id, owner.email]);
    for (const [kind, title, content] of kb) {
      await db.query('insert into knowledge_items (workspace_id, kind, title, content) values ($1,$2,$3,$4)', [ws.id, kind, title, content]);
    }
    return ws;
  };
  const bright = await mk('Bright Path Tutoring', 'bright-path', 'pilot', 'America/New_York', MAYA, KB_BRIGHT, { reply_from: 'Maya at Bright Path Tutoring', reply_to: 'hello@brightpath.demo' });
  await db.query(`insert into memberships (workspace_id, user_id, email, role) values ($1,$2,$3,'staff')`, [bright.id, JORDAN.id, JORDAN.email]);
  await db.query(`update workspaces set open_days='{1,2,3,4,6}', open_hour=9, close_hour=20 where id=$1`, [bright.id]);
  const summit = await mk('Summit Learning Center', 'summit-learning', 'starter', 'America/Los_Angeles', SAM, KB_SUMMIT);

  const run = async (ws, ownerId, samples) => {
    const ctx = { userId: ownerId, workspaceId: ws.id, role: 'owner' };
    for (const s of samples) {
      const base = Date.now() - s.daysAgo * 86_400_000;
      t = base;
      const { leadId } = await svc.submitInquiry(ws.slug, s);
      let step = base;
      const at = (mins) => { step += mins * 60_000; t = step; };
      for (const action of s.path) {
        if (action === 'approve') {
          at(25 + Math.floor(Math.random() * 90));
          const { messages } = await svc.getLead(ctx, leadId);
          const draft = messages.find((m) => m.status === 'pending_review');
          if (draft) await svc.approveMessage(ctx, draft.id, { acknowledgeFlags: true });
        } else if (action === 'book') {
          at(60 * 24);
          const start = new Date(step + 2 * 86_400_000); start.setUTCHours(21, 0, 0, 0);
          await svc.bookAppointment(ctx, leadId, { starts_at: start.toISOString(), kind: 'consultation' });
          await svc.runDueReminders();
        } else if (action === 'complete') {
          const { appointments } = await svc.getLead(ctx, leadId);
          t = new Date(appointments[0].starts_at).getTime() + 3_600_000; step = t;
          await svc.runDueReminders();
          await svc.updateAppointment(ctx, appointments[0].id, { status: 'completed' });
        } else if (action === 'enroll') {
          at(60 * 20);
          await svc.changeStage(ctx, leadId, 'enrolled');
        } else if (action === 'close') {
          at(60 * 24 * 2);
          await svc.changeStage(ctx, leadId, 'closed', { reason: 'Chose another provider' });
        }
      }
    }
  };
  await run(bright, MAYA.id, SAMPLES_BRIGHT);
  await run(summit, SAM.id, [
    { daysAgo: 3, parent_name: 'Ruth Alvarez', email: 'ruth.a@example.com', message: 'My 3rd grader needs homework help a few days a week.', path: ['approve'] },
  ]);
  t = null;
  // Catch up anything that became due between the sample dates and now (creates follow-ups in the queue).
  await svc.runDueReminders();
}

// Rules-based (non-AI) message templates for programmed follow-ups. Facts come only from the
// lead record, the appointment record and workspace settings — never invented.
const first = (n) => (n || '').trim().split(/\s+/)[0] || 'there';
const sign = (ws) => `\n\nBest regards,\n${ws.reply_from || ws.name}`;
const nextStep = (ws) => (ws.booking_link
  ? `You can pick a time that works for you here: ${ws.booking_link}`
  : 'Just reply with a few days and times that work for you and we will confirm.');

export function formatWhen(date, timezone) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: timezone, timeZoneName: 'short',
  }).format(new Date(date));
}

const KIND_LABEL = { consultation: 'consultation', assessment: 'assessment', trial_session: 'trial session' };

export function reminderMessage(kind, { lead, ws, appt }) {
  const about = lead.subject ? ` about ${lead.subject} support` : '';
  switch (kind) {
    case 'follow_up_1':
      return { purpose: 'follow_up', subject: `Following up on your tutoring inquiry`,
        body: `Hi ${first(lead.parent_name)},\n\nI wanted to follow up on your recent message to ${ws.name}${about}. We'd be happy to talk through what your student needs and how we can help.\n\n${nextStep(ws)}${sign(ws)}` };
    case 'follow_up_2':
      return { purpose: 'follow_up', subject: `Checking in one last time`,
        body: `Hi ${first(lead.parent_name)},\n\nI'm checking in one last time about your inquiry${about}. If now isn't the right time, no problem at all — you can reply whenever you're ready and we'll pick up where we left off.\n\n${nextStep(ws)}${sign(ws)}` };
    case 'appointment_reminder':
      return { purpose: 'appointment_reminder', subject: `Reminder: your ${KIND_LABEL[appt.kind]} with ${ws.name}`,
        body: `Hi ${first(lead.parent_name)},\n\nThis is a friendly reminder of your ${KIND_LABEL[appt.kind]} with ${ws.name} on ${formatWhen(appt.starts_at, ws.timezone)}.\n\nIf you need to reschedule, just reply to this email.${sign(ws)}` };
    case 'post_appointment':
      return { purpose: 'post_appointment', subject: `Thank you for meeting with ${ws.name}`,
        body: `Hi ${first(lead.parent_name)},\n\nThank you for taking the time to meet with us. If you have any questions about next steps, or you're ready to set up a regular schedule, just reply to this email and we'll take care of it.${sign(ws)}` };
    default:
      throw new Error(`No template for ${kind}`);
  }
}

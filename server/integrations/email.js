// Outgoing email. Live via Resend (https://resend.com) when RESEND_API_KEY is set;
// otherwise SIMULATED: nothing leaves the server, and the message is recorded as delivery_mode='simulated'.
export function createEmail(config, { fetchImpl = globalThis.fetch } = {}) {
  const live = Boolean(config.resendKey && config.emailFrom);
  return {
    live,
    async send({ to, subject, text, fromName, replyTo }) {
      if (!to) throw new Error('Lead has no email address');
      if (!live) return { mode: 'simulated', id: `sim_${Date.now().toString(36)}` };
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.resendKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: fromName ? `${fromName} <${config.emailFrom}>` : config.emailFrom,
          to: [to], subject, text, reply_to: replyTo || undefined,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Email provider error ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      return { mode: 'live', id: data.id };
    },
  };
}

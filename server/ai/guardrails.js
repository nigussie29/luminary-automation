// Deterministic checks applied to EVERY outgoing draft (AI, template, or staff-edited),
// so the system never sends a price, availability promise or policy that isn't in the
// center's approved knowledge base without a human explicitly acknowledging it.

const MONEY = /\$\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?(?:\/|per)\s?\w+)?/gi;
const AVAILABILITY_CLAIMS = [
  /\b(?:we|i)\s+(?:have|'ve got)\s+(?:an?\s+)?(?:opening|openings|slot|slots|spot|spots|availability)\b/i,
  /\b(?:spots?|slots?|seats?)\s+(?:are\s+|is\s+)?(?:still\s+)?(?:open|available|left)\b/i,
  /\b(?:is|are)\s+available\s+(?:on|at|this|next|tomorrow|today)\b/i,
  /\bguarantee[sd]?\b/i,
];

const normalizeMoney = (s) => s.replace(/\s/g, '').replace(/per/i, '/').replace(/,/g, '').toLowerCase().match(/\$\d+(?:\.\d+)?/)?.[0];

export function knowledgeText(kb) {
  return kb.map((k) => `${k.title} ${k.content}`).join('\n');
}

/** Returns an array of flags: { code, severity: 'block'|'warn', message } */
export function checkDraft(body, kb) {
  const flags = [];
  const kbText = knowledgeText(kb);
  const kbAmounts = new Set((kbText.match(MONEY) || []).map(normalizeMoney));
  const unknown = [...new Set((body.match(MONEY) || []).map(normalizeMoney))].filter((a) => a && !kbAmounts.has(a));
  if (unknown.length) {
    flags.push({ code: 'unverified_price', severity: 'block',
      message: `Mentions ${unknown.join(', ')}, which is not in the approved price list. Edit the text or add the price to the knowledge base.` });
  }
  for (const re of AVAILABILITY_CLAIMS) {
    if (re.test(body)) {
      flags.push({ code: 'availability_claim', severity: 'block',
        message: 'Promises availability or results. Confirm with your schedule before sending, or remove the claim.' });
      break;
    }
  }
  if (/\{\{|\[(?:insert|name|price|date|time)[^\]]*\]/i.test(body)) {
    flags.push({ code: 'placeholder', severity: 'block', message: 'Contains an unfilled placeholder.' });
  }
  return flags;
}

export const hasBlockingFlags = (flags) => (flags || []).some((f) => f.severity === 'block');

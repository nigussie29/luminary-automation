// Unit-economics model for Luminary Automation. EVERY number below is an ASSUMPTION to replace
// with real data from pilots. Run:  npm run economics
// Edit the ASSUMPTIONS object, re-run, and watch break-even move.

const A = {
  // ---- Revenue (proposed list prices, USD/month)
  plans: {
    starter: { price: 149, mix: 0.6, inquiriesPerMonth: 80 },
    growth:  { price: 299, mix: 0.3, inquiriesPerMonth: 250 },
    pro:     { price: 549, mix: 0.1, inquiriesPerMonth: 700 },
  },
  // ---- Variable cost per customer
  aiOpsPerInquiry: 2,                 // analyze + draft (follow-ups use templates: no AI cost)
  tokensPerOp: { input: 1800, output: 450 },
  aiPricePerMTok: { input: 0.10, output: 0.50 },   // Claude Haiku 5.5 list price (Oct 2026); Sonnet 5.5 is $2/$10
  emailsPerInquiry: 3,                // first reply + ~2 follow-ups/reminders
  emailCostPerThousand: 0.40,         // transactional email provider, paid tier
  infraVariablePerCustomer: 1.50,     // DB rows, bandwidth, logs
  paymentFeePct: 0.029, paymentFeeFixed: 0.30, // card processing
  supportHoursPerCustomer: 1.0,       // monthly, after onboarding
  // ---- Fixed monthly costs (not tied to customer count)
  ownerHourlyRate: 40,                // value of YOUR time — include it, even if unpaid
  devHoursPerMonth: 20,               // maintenance, bug fixes, small features
  infraBase: 50,                      // hosting + managed Postgres base plans
  tools: 60,                          // domain, email provider base, monitoring, accounting software
  insuranceLegalAccounting: 120,
  // ---- Acquisition
  salesHoursPerNewCustomer: 12,       // research, outreach, demos, onboarding calls
  paidSpendPerNewCustomer: 75,        // events, ads, travel, referral bonuses
  newCustomersPerMonth: 3,
  // ---- One-time build cost to recover
  buildHours: 160,
};

const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function perPlan(p) {
  const ops = p.inquiriesPerMonth * A.aiOpsPerInquiry;
  const ai = ops * (A.tokensPerOp.input * A.aiPricePerMTok.input + A.tokensPerOp.output * A.aiPricePerMTok.output) / 1e6;
  const email = (p.inquiriesPerMonth * A.emailsPerInquiry / 1000) * A.emailCostPerThousand;
  const payment = p.price * A.paymentFeePct + A.paymentFeeFixed;
  const support = A.supportHoursPerCustomer * A.ownerHourlyRate;
  const variable = ai + email + A.infraVariablePerCustomer + payment + support;
  return { ai, email, payment, support, variable, contribution: p.price - variable };
}

const rows = Object.entries(A.plans).map(([name, p]) => ({ name, ...p, ...perPlan(p) }));
const blended = (k) => rows.reduce((s, r) => s + r[k] * r.mix, 0);
const arpu = blended('price');
const variable = blended('variable');
const contribution = arpu - variable;
const fixed = A.devHoursPerMonth * A.ownerHourlyRate + A.infraBase + A.tools + A.insuranceLegalAccounting;
const cac = A.salesHoursPerNewCustomer * A.ownerHourlyRate + A.paidSpendPerNewCustomer;
const acquisitionPerMonth = cac * A.newCustomersPerMonth;
const breakEvenSteady = Math.ceil(fixed / contribution);
const breakEvenGrowing = Math.ceil((fixed + acquisitionPerMonth) / contribution);
const build = A.buildHours * A.ownerHourlyRate;

console.log('\nLUMINARY AUTOMATION — UNIT ECONOMICS (all inputs are assumptions)\n');
console.log('Per customer per month');
for (const r of rows) {
  console.log(`  ${r.name.padEnd(8)} price ${money(r.price).padStart(9)}  AI ${money(r.ai).padStart(7)}  email ${money(r.email).padStart(6)}  payments ${money(r.payment).padStart(7)}  support ${money(r.support).padStart(7)}  => contribution ${money(r.contribution)}`);
}
console.log(`\n  Blended revenue per customer (ARPU):  ${money(arpu)}`);
console.log(`  Blended variable cost per customer:   ${money(variable)}  (AI is ${money(blended('ai'))} of it)`);
console.log(`  Contribution margin per customer:     ${money(contribution)}  (${Math.round(contribution / arpu * 100)}%)`);
console.log(`\nFixed costs per month:                  ${money(fixed)}  (incl. ${A.devHoursPerMonth} dev hours at ${money(A.ownerHourlyRate)}/h)`);
console.log(`Customer acquisition cost (CAC):        ${money(cac)}  -> payback ${(cac / contribution).toFixed(1)} months`);
console.log(`\nBreak-even customers, no new sales:     ${breakEvenSteady}`);
console.log(`Break-even while adding ${A.newCustomersPerMonth}/month:       ${breakEvenGrowing}`);
console.log(`One-time build cost to recover:         ${money(build)}`);
console.log('\nMonthly operating profit = customers x contribution - fixed - (new customers x CAC)');
for (const n of [3, 10, 20, 40]) {
  const profit = n * contribution - fixed - acquisitionPerMonth;
  console.log(`  ${String(n).padStart(3)} customers: ${money(profit).padStart(11)}`);
}
console.log('');

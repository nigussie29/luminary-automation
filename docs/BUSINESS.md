# Luminary Automation — Business Plan (v0, assumptions to test)

Everything marked **[assumption]** has to be confirmed or replaced with data from real tutoring centers. Treat this document as a set of hypotheses with a plan to test each one.

---

## 1. The one problem

**Independent tutoring centers lose families who were ready to enroll, because no one replies quickly and no one follows up.**

How it happens: a parent fills in a web form at 9:40 pm, sends a Facebook message, or leaves a voicemail. The owner is teaching until 8 pm and does admin late at night or on weekends. The inquiry sits in one of three inboxes. A reply goes out the next day or two days later, often a generic one that doesn't answer the question, and there is no second follow-up. Meanwhile the parent contacted two other centers, and one of them called back that evening.

Why it matters: a center's most expensive asset is the family who has already decided to look for tutoring. **[assumption]** One enrolled student is worth $200–$600 a month for 4–9 months, so a single lost family can cost more than a year of this software.

### Ideal customer profile (ICP)

| | |
|---|---|
| **Who** | Independent or small multi-location tutoring and test-prep centers, K-12, owner-operated |
| **Size** | 1–3 locations, 2–15 staff and tutors, **[assumption]** 20–150 inquiries a month |
| **Signals** | A web inquiry form or "contact us" page, active Google Business profile, runs ads or sees seasonal spikes (August–September, January, before SAT/ACT dates), no dedicated front-desk person after hours |
| **Buyer** | The owner, who also feels the pain personally |
| **User** | Owner plus 1–3 admin or tutor staff who answer inquiries |
| **Not a fit (yet)** | Large franchises with central CRMs (Mathnasium, Kumon corporate systems), solo tutors with fewer than 10 inquiries a month, online-only marketplaces |

### What they use today **[assumption — verify in interviews]**
Gmail plus a spreadsheet; sometimes a scheduling tool (Acuity, Calendly); sometimes tutoring-business software (TutorBird, Teachworks, Oases) that handles billing and scheduling but not the first reply or the follow-up.

---

## 2. The pilot offer (what you say to a center owner)

> **"Every family who asks about tutoring hears back the same day — and gets followed up until they book or say no."**
>
> For 60 days, Luminary Automation collects your inquiries in one place, drafts a reply from your own prices and services for you to approve in one click, and reminds families who go quiet. I set it up for you in a 45-minute call.
>
> **Pilot price: $99/month for 2 months** (the normal price will be $149 or more).
> **Guarantee:** if your median first-reply time isn't under 2 hours during business hours by day 30, the second month is free.
> In return, I ask for your inquiry timestamps from the last 90 days (to measure a baseline) and a 20-minute check-in every two weeks.

Why paid rather than free: payment is the cheapest real test of demand, and a paying pilot customer gives honest feedback.

---

## 3. Subscription tiers **[all prices are assumptions]**

| | **Starter** | **Growth** | **Pro** |
|---|---|---|---|
| Price / month | $149 | $299 | $549 |
| Locations (workspaces) | 1 | 1 | 3 |
| Team seats | 3 | 8 | 25 |
| AI actions / month (≈ 2 per inquiry) | 400 (≈200 inquiries) | 1,200 (≈600) | 4,000 (≈2,000) |
| Review queue, follow-ups, reminders, dashboard | ✓ | ✓ | ✓ |
| Booking link in replies | ✓ | ✓ | ✓ |
| SMS follow-ups (roadmap) | — | ✓ | ✓ |
| Calendar sync (roadmap) | — | ✓ | ✓ |
| Support | Email | Email + monthly review call | Priority + onboarding for each location |

Past the AI limit, the product doesn't stop: drafts fall back to templates and the dashboard shows the usage. This keeps cost risk bounded without hurting the customer. Limits and seats are enforced in code (`server/rules.js`).

**Anchoring check:** if Starter recovers a single student every two months, it pays for itself several times over **[assumption]**. Test this in pilot interviews: *"If this got you one more enrolled family a month, what would that be worth?"*

---

## 4. Unit economics — how to calculate each number

Run `npm run economics` to compute these from the editable assumptions in `scripts/unit-economics.js`. Current output:

| Metric | Formula | Current estimate |
|---|---|---|
| **Revenue per customer (ARPU)** | Σ (plan price × share of customers on that plan) | **$234 / month** (60% Starter, 30% Growth, 10% Pro) |
| **AI cost per customer** | inquiries × 2 ops × (input tokens × input price + output tokens × output price) | **$0.06–$0.57 / month** with Claude Haiku 5.5 ($0.10 / $0.50 per million tokens). About 20× more with Sonnet 5.5; still under $12 |
| **Infrastructure cost per customer** | variable hosting/DB/email + share of fixed base plans | **~$1.60 / month** variable; $50 / month fixed base |
| **Payment processing** | price × 2.9% + $0.30 | $4.62–$16.22 |
| **Support labor** | hours per customer × your hourly rate | **$40 / month** (1 hour at $40) — the largest cost |
| **Contribution margin** | ARPU − all variable costs | **$185 / month (79%)** |
| **Fixed costs** | dev/maintenance hours × rate + hosting base + tools + insurance/legal/accounting | **$1,030 / month** (20 dev hours at $40, $50 hosting, $60 tools, $120 admin) |
| **Customer acquisition cost (CAC)** | (sales hours × rate + paid spend) ÷ new customers | **$555** (12 hours at $40 + $75 per customer) |
| **CAC payback** | CAC ÷ contribution per customer | **3.0 months** |
| **Monthly operating profit** | customers × contribution − fixed − new customers × CAC | 3 → −$2,140; 10 → −$845; 20 → +$1,006; 40 → +$4,706 |
| **Break-even customers** | fixed ÷ contribution (steady state) | **6** with no new sales; **15** while adding 3 a month |
| **One-time build cost** | build hours × rate | $6,400 (160 hours at $40), recovered from profit after break-even |

What this tells you:
1. **AI is not the cost problem.** At Haiku pricing it rounds to zero. Don't over-optimize prompts; optimize onboarding and support time.
2. **Your time is the real cost.** Support hours per customer and sales hours per new customer drive profitability. Track both from day one with a simple time log per customer.
3. **Price, not cost, is the biggest unknown.** If every center only pays $79, contribution drops to about $35 per customer and break-even rises to about 30 customers. The pilots must test willingness to pay.
4. Owner labor is valued at **$40/hour [assumption]**. Use your real opportunity cost (for example, what you'd earn teaching an hour of data analytics).

---

## 5. Recruiting three paying pilot customers (30 days)

**Week 1 — build a list of 40 centers.**
- Search Google Maps for "tutoring center", "SAT prep" and "math tutoring" within driving distance, plus the communities where your own students' families live.
- Keep centers that match the ICP: independent, a web form, recent Google reviews, at least one staff member.
- Record the owner's name, form URL, Google review count, and any review complaining about slow replies ("never called back" is the best signal).

**Week 1–2 — reach out in three ways.**
1. **Warm network first.** Your LearnWithGuluma and Luminary contacts: parents, teachers, other tutors. Ask: *"Do you know a tutoring center owner who's swamped with admin?"* Introductions convert far better than cold outreach.
2. **Short personal email or LinkedIn message** to owners. Use one specific observation and one question; don't pitch features:
   > *"Hi Dana — I'm an instructor building a tool for tutoring centers. When a parent fills in your website form at 9 pm, what happens until someone replies? I'm looking for three centers to pilot a system that drafts the reply from your own prices and follows up automatically. 15 minutes this week?"*
3. **In person.** Visit 10 centers during a quiet hour (late morning) with a one-page printout of the dashboard and the guarantee.

**Week 2–3 — 15-minute discovery calls (aim for 12).** Ask, then listen:
- "Walk me through the last inquiry you got. When did it arrive, and when did you reply?"
- "How many inquiries a month? How many become students?"
- "What happens to families who don't reply after your first message?"
- "If you replied the same day to everyone, what would change?"
Disqualify centers with fewer than 15 inquiries a month or a real front desk that already responds within an hour.

**Week 3–4 — close three.** Show the demo using *their* services and prices, typed into the knowledge base during the call. Offer the pilot terms above. Set up together and send a test inquiry through their own form before ending the call.

Expected funnel **[assumption]**: 40 contacted → 12 calls → 5 interested → 3 paying.

---

## 6. Measuring whether it works

### Baseline (before go-live)
From each center's inbox or spreadsheet, export the last **90 days** of inquiries. For each one, record when it arrived, when the first reply went out, whether a consultation was booked, and whether the student enrolled. A shared sheet with those four columns is enough. If records are incomplete, use the most recent 30 inquiries you can reconstruct, and note which are estimates.

### During the pilot (built into the dashboard)
| Metric | Definition | Target **[assumption]** |
|---|---|---|
| **Median first-reply time** | inquiry received → first message sent (`leads.first_response_at − created_at`) | < 2 hours in business hours (from a typical 12–30 hours) |
| % replied within 1 hour | share of inquiries with first reply < 60 min | > 60% |
| Follow-up coverage | share of non-booking leads that got ≥1 follow-up | > 90% |
| Inquiry → booked | leads with any appointment ÷ inquiries | +25% relative to baseline |
| Inquiry → enrolled | enrolled ÷ inquiries | directional improvement |
| Staff minutes per inquiry | short self-reported log for 2 weeks, before vs during | −50% |
| Draft acceptance | AI drafts sent with light or no edits | > 70% |

### Being honest about the results
Three centers × roughly 30–60 inquiries over 60 days is too small a sample to prove a conversion lift statistically. Season matters too: September is not like June. So:
- Treat **response time and follow-up coverage** as the primary evidence. They move immediately and you control them.
- Treat **conversion** as directional. Compare against the same months last year where possible, and report the raw counts, not just percentages.
- Write down the decision rule **before** the pilot: *Continue if at least 2 of 3 centers convert to paid at ≥ $149 and median reply time falls below 2 hours. Otherwise interview the centers about why, and revisit the problem or the price.*

### Biweekly check-in agenda (20 minutes)
1. Review the dashboard numbers together.
2. Ask: "Which drafts did you rewrite, and why?" Use the answers to improve the knowledge base and templates.
3. Ask: "Did anything go wrong or feel risky?" Then check the Automation history.
4. Near day 45, ask: "Would you keep paying $149 for this? What would make it a no-brainer?"

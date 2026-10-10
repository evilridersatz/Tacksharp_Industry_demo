/**
 * Fills a SEPARATE demo database with 14 days of realistic activity so the dashboard
 * can be reviewed without real Meta / Plivo / Sarvam traffic.
 *
 *   DB_NAME=tacksharp_demo npm run db:push -w apps/api
 *   DB_NAME=tacksharp_demo npm run seed -w apps/api
 *   DB_NAME=tacksharp_demo npm run seed:demo -w apps/api
 *
 * Refuses to run unless DB_NAME ends with "_demo", so it can never touch real data.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '@prisma/client';
import { buildCallSummary } from '../src/voice/call-summary.js';

const dbName = process.env.DB_NAME ?? '';
if (!dbName.endsWith('_demo')) {
  console.error(`Refusing to seed demo data into "${dbName || '(default)'}". Use a database whose name ends with _demo.`);
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaMariaDb({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? 'password',
    database: dbName,
  }),
});

const ORG = process.env.DEFAULT_ORGANIZATION_ID ?? 'org_real_estate_001';
const H = 3600_000;
const now = Date.now();
// Tomorrow 6 PM IST — when a customer says "tomorrow evening call pannunga"
const tomorrowEvening = (() => {
  const ist = new Date(now + 5.5 * H + 24 * H);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 18, 0) - 5.5 * H);
})();
let seq = 0;
const rnd = (() => {
  let x = 42;
  return () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
})();
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];

const NAMES = [
  'Ravi Kumar', 'Meena S', 'Karthik R', 'Lakshmi Narayanan', 'Senthil M', 'Priya Venkat', 'Arun Prakash', 'Divya K',
  'Gopal R', 'Revathi K', 'Suresh Babu', 'Anitha P', 'Bala S', 'Nandhini V', 'Mohammed F', 'Deepa N',
  'Vignesh T', 'Kavitha R', 'Rajesh Iyer', 'Sangeetha M', 'Hari Krishnan', 'Janani S', 'Prakash Raj', 'Yamuna D',
  'Dinesh Kumar', 'Shalini G', 'Ashwin V', 'Bhuvana R', 'Manikandan S', 'Keerthana P', 'Saravanan K', 'Pooja Iyer',
  'Naveen R', 'Gayathri S', 'Sathya Moorthy', 'Ilakkiya M',
];
const AREAS = ['Porur', 'OMR', 'Velachery', 'Tambaram', 'Guduvanchery', 'Porur', 'Velachery'];
const CAMPAIGN_BY_AREA: Record<string, string> = {
  Porur: 'Porur Diwali Campaign',
  OMR: 'OMR 2BHK Launch',
  Velachery: 'Velachery Ready-to-move',
  Tambaram: 'Tambaram Villas',
  Guduvanchery: 'Guduvanchery Plots',
};

type Plan = {
  status: string;
  inbound?: boolean;
  area?: string;
  bhk?: number;
  budget?: number;
  calls: Array<{ outcome: string; status: string; dur?: number; lines?: Array<[string, string]> }>;
  whatsapp?: Array<[string, string]>;
  visit?: boolean;
  task?: string;
  callback?: boolean;
  doNotContact?: boolean;
};

const PLANS: Plan[] = [
  { status: 'new', calls: [] },
  { status: 'contacted', calls: [{ status: 'no_answer', outcome: 'no_answer' }] },
  {
    status: 'qualified',
    area: 'Porur',
    bhk: 2,
    budget: 8_000_000,
    calls: [],
    whatsapp: [
      ['user', 'Porur la 2 BHK iruka? Budget eighty lakhs kulla venum'],
      ['assistant', 'Vanakkam! Porur la Green Valley Residency 2 BHK ₹72 L la irukku. Site visit arrange pannalaama?'],
      ['user', 'Weekend paakalaam. Details anuppunga'],
      ['assistant', 'Sure! Saturday 11 AM or 4 PM — edhu convenient?'],
    ],
  },
  {
    status: 'site_visit',
    area: 'Porur',
    bhk: 2,
    visit: true,
    calls: [
      {
        status: 'completed',
        outcome: 'site_visit_booked',
        dur: 154,
        lines: [
          ['assistant', 'வணக்கம், நான் Tacksharp Realty-ல இருந்து AI assistant பேசுறேன். நீங்க 2 BHK பத்தி enquiry பண்ணியிருந்தீங்க. இப்போ ரெண்டு நிமிஷம் பேசலாமா?'],
          ['user', 'Haan sollunga, Porur la 2 BHK venum'],
          ['assistant', 'சரி, Porur-ல Green Valley Residency 72 lakhs-ல இருக்கு. Site visit பண்ணலாமா?'],
          ['user', 'Saturday 11 mani ok'],
          ['assistant', 'Saturday 11 AM-க்கு site visit book பண்ணிட்டேன். WhatsApp-ல details அனுப்புறேன். Thank you!'],
        ],
      },
    ],
  },
  {
    status: 'callback',
    callback: true,
    calls: [
      {
        status: 'completed',
        outcome: 'callback_requested',
        dur: 41,
        lines: [
          ['assistant', 'வணக்கம், நான் Tacksharp Realty-ல இருந்து AI assistant பேசுறேன். இப்போ பேசலாமா?'],
          ['user', 'Office la irukken, tomorrow evening call pannunga'],
          ['assistant', 'சரி, நாளைக்கு evening 6 மணிக்கு call பண்றேன். Thank you!'],
        ],
      },
    ],
  },
  {
    status: 'human_handoff',
    area: 'Velachery',
    task: 'Handoff: Agent kitta pesanum — wants loan options',
    calls: [
      {
        status: 'completed',
        outcome: 'human_requested',
        dur: 63,
        lines: [
          ['assistant', 'வணக்கம், நான் Tacksharp Realty-ல இருந்து AI assistant பேசுறேன். உங்க Velachery enquiry பத்தி பேசலாமா?'],
          ['user', 'Loan pathi detail-a agent kitta pesanum'],
          ['assistant', 'சரி, நம்ம team உங்களை இன்னைக்கே call பண்ணுவாங்க. Thank you!'],
        ],
      },
    ],
  },
  {
    status: 'not_interested',
    doNotContact: true,
    calls: [
      {
        status: 'completed',
        outcome: 'not_interested',
        dur: 22,
        lines: [
          ['assistant', 'வணக்கம், Tacksharp Realty-ல இருந்து பேசுறேன். உங்க property enquiry பத்தி பேசலாமா?'],
          ['user', 'Illa, enakku vendam. Already vaangiten'],
          ['assistant', 'சரி, புரிஞ்சுது. Thank you, have a nice day!'],
        ],
      },
    ],
  },
  { status: 'contacted', calls: [{ status: 'busy', outcome: 'busy' }, { status: 'no_answer', outcome: 'no_answer' }] },
  {
    status: 'property_interested',
    area: 'OMR',
    bhk: 3,
    budget: 10_000_000,
    calls: [],
    whatsapp: [
      ['user', 'Hi, OMR la 3 BHK apartment iruka? Budget 1 crore'],
      ['assistant', 'Hi! OMR-la ippo 3 BHK illa, aana Sunrise Heights 2 BHK ₹68 L irukku. Paakalaamaa?'],
      ['user', 'Sunrise Heights photos anuppunga, interested'],
    ],
  },
  { status: 'won', visit: true, calls: [{ status: 'completed', outcome: 'site_visit_booked', dur: 188 }] },
  {
    status: 'qualified',
    inbound: true,
    calls: [
      {
        status: 'completed',
        outcome: 'qualified',
        dur: 97,
        lines: [
          ['assistant', 'வணக்கம், Tacksharp Realty-க்கு call பண்ணதுக்கு நன்றி. நான் AI assistant. உங்களுக்கு என்ன மாதிரி property பாக்கறீங்க?'],
          ['user', 'Velachery la 2 BHK venum, budget 85 lakhs'],
          ['assistant', 'சரி, Velachery-ல Metro Square 2 BHK 84 lakhs-ல இருக்கு. Details WhatsApp-ல அனுப்பட்டுமா?'],
          ['user', 'Haan anuppunga, thanks'],
        ],
      },
    ],
  },
];

async function main() {
  const properties = await prisma.property.findMany({ where: { organizationId: ORG } });
  if (properties.length === 0) throw new Error('Run "npm run seed" first (creates the organization and properties).');

  for (const [i, name] of NAMES.entries()) {
    const plan = PLANS[i % PLANS.length];
    // Leads arrive between 9 AM and 6 PM IST, spread over the last 14 days
    const dayStart = (() => {
      const ist = new Date(now + 5.5 * H - Math.floor((i / NAMES.length) * 14) * 24 * H);
      return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 5.5 * H;
    })();
    let created = new Date(dayStart + (9 + rnd() * 9) * H);
    if (created.getTime() > now - 3 * H) created = new Date(now - (3 + rnd() * 2) * H);
    const phone = `9198${String(40000000 + i * 7919).slice(0, 8)}`;
    const area = plan.area ?? pick(AREAS);
    const type = area === 'Tambaram' ? 'Villa' : area === 'Guduvanchery' ? 'Plot' : 'Apartment';
    const bhk = type === 'Plot' ? null : plan.bhk ?? pick([2, 2, 3, 2]);
    const budget = plan.budget ?? (type === 'Villa' ? pick([12_000_000, 13_500_000]) : type === 'Plot' ? pick([3_500_000, 4_200_000]) : pick([6_500_000, 7_200_000, 8_000_000, 9_500_000]));
    const campaign = CAMPAIGN_BY_AREA[area];
    const lastInbound = plan.whatsapp ? new Date(created.getTime() + 2 * H) : null;

    const customer = await prisma.customer.create({
      data: {
        organizationId: ORG,
        name,
        phone,
        source: 'meta_lead_ads',
        location: area,
        bhk,
        budget,
        propertyType: type,
        language: pick(['tamil', 'tamil', 'english']),
        doNotContact: Boolean(plan.doNotContact),
        lastInboundAt: lastInbound,
        callbackAt: plan.callback ? tomorrowEvening : null,
        createdAt: created,
      },
    });
    const lead = await prisma.lead.create({
      data: {
        organizationId: ORG,
        customerId: customer.id,
        status: plan.status,
        source: 'meta_lead_ads',
        campaign,
        externalRef: `demo-${i}`,
        location: area,
        bhk,
        budget,
        propertyType: type,
        createdAt: created,
      },
    });

    // Follow-up sequence
    const steps: Array<[number, string, string]> = [
      [0, 'whatsapp', 'first_contact'],
      [0.5, 'whatsapp', 'reminder'],
      [2, 'voice', 'call'],
      [24, 'whatsapp', 'final'],
    ];
    for (const [h, channel, step] of steps) {
      const at = new Date(created.getTime() + h * H);
      const due = at.getTime() < now;
      const stopped = plan.whatsapp || ['not_interested', 'human_handoff', 'callback', 'site_visit', 'won'].includes(plan.status);
      let status = due ? 'completed' : 'scheduled';
      let reason: string | null = null;
      let lastError: string | null = null;
      if (channel === 'whatsapp' && due && !plan.whatsapp) {
        status = 'skipped';
        lastError = 'Customer has not messaged in the last 24h and no approved WhatsApp template is configured (WHATSAPP_TEMPLATE_NAME).';
      }
      if (stopped && (h > 0.5 || !due)) {
        status = 'cancelled';
        reason = plan.whatsapp ? 'Customer replied on WhatsApp' : `Call connected (${plan.calls[0]?.outcome ?? 'connected'})`;
      }
      await prisma.followUp.create({
        data: {
          organizationId: ORG, leadId: lead.id, customerId: customer.id, channel,
          action: channel === 'voice' ? 'call' : 'message', message: step, scheduledAt: at, status,
          cancellationReason: reason, lastError, source: 'sequence',
          completedAt: status === 'completed' ? at : null, createdAt: created,
          updatedAt: status === 'cancelled' ? new Date(created.getTime() + 2.2 * H) : due ? at : created,
        },
      });
    }
    if (plan.callback) {
      await prisma.followUp.create({
        data: {
          organizationId: ORG, leadId: lead.id, customerId: customer.id, channel: 'voice', action: 'callback',
          message: 'tomorrow evening', scheduledAt: tomorrowEvening, status: 'scheduled', source: 'callback',
          createdAt: new Date(created.getTime() + 2.1 * H), updatedAt: new Date(created.getTime() + 2.1 * H),
        },
      });
    }
    if (plan.task) {
      await prisma.followUp.create({
        data: {
          organizationId: ORG, leadId: lead.id, customerId: customer.id, channel: 'human', action: 'handoff',
          message: plan.task, scheduledAt: new Date(created.getTime() + 2.2 * H), status: 'open', source: 'task',
          createdAt: new Date(created.getTime() + 2.2 * H), updatedAt: new Date(created.getTime() + 2.2 * H),
        },
      });
    }

    // WhatsApp conversation
    if (plan.whatsapp) {
      const conv = await prisma.conversation.create({
        data: { id: randomUUID(), organizationId: ORG, customerId: customer.id, channel: 'whatsapp', externalId: phone, updatedAt: new Date(created.getTime() + 3 * H) },
      });
      for (const [k, [role, content]] of plan.whatsapp.entries()) {
        await prisma.message.create({
          data: { id: randomUUID(), organizationId: ORG, conversationId: conv.id, role, content, createdAt: new Date(created.getTime() + 2 * H + k * 90_000) },
        });
      }
    }

    // Calls (+ transcript in the voice conversation)
    let voiceConv: { id: string } | null = null;
    for (const [k, c] of plan.calls.entries()) {
      const start = new Date(created.getTime() + (2 + k * 2) * H);
      const answered = c.status === 'completed';
      const callRow = await prisma.call.create({
        data: {
          organizationId: ORG, customerId: customer.id, leadId: lead.id, direction: plan.inbound ? 'inbound' : 'outbound', status: c.status,
          summary: buildCallSummary({
            direction: plan.inbound ? 'inbound' : 'outbound',
            outcome: c.outcome,
            language: answered ? 'ta-IN' : null,
            customer: { location: area, bhk, propertyType: type, budget },
          }),
          outcome: c.outcome, toNumber: phone, fromNumber: '914400000000', providerCallId: `demo-${++seq}`,
          attempt: k + 1, turns: c.lines ? Math.ceil(c.lines.length / 2) : answered ? 3 : 0, language: answered ? 'ta-IN' : null,
          answeredAt: answered ? new Date(start.getTime() + 8000) : null,
          endedAt: new Date(start.getTime() + (c.dur ?? 30) * 1000 + 8000), durationSec: answered ? c.dur ?? 60 : null,
          hangupCause: answered ? 'Normal Hangup' : c.status === 'busy' ? 'Busy Line' : 'No Answer', createdAt: start,
        },
      });
      if (c.lines) {
        voiceConv ??= await prisma.conversation.create({
          data: { id: randomUUID(), organizationId: ORG, customerId: customer.id, channel: 'voice', externalId: phone, updatedAt: start },
        });
        const lastAi = c.lines.map(([r]) => r).lastIndexOf('assistant');
        for (const [j, [role, content]] of c.lines.entries()) {
          // Same per-turn fields the live engine records, so the call review shows rules vs model, language and speed.
          const language = /[\u0B80-\u0BFF]/.test(content) ? 'ta' : 'en';
          const metadata =
            role === 'user'
              ? { callId: callRow.id, language }
              : {
                  callId: callRow.id, path: 'rules', language, aiRequests: 0, ms: 320 + ((j * 137) % 540),
                  ...(j === lastAi && c.outcome === 'site_visit_booked' ? { booking: 'booked' } : {}),
                };
          await prisma.message.create({
            data: { id: randomUUID(), organizationId: ORG, conversationId: voiceConv.id, role, content, metadata, createdAt: new Date(start.getTime() + 9000 + j * 12_000) },
          });
        }
      }
    }

    if (plan.visit) {
      const property = properties.find((p) => p.location === area) ?? properties[0];
      await prisma.siteVisit.create({
        data: {
          id: randomUUID(), organizationId: ORG, leadId: lead.id, customerId: customer.id, propertyId: property.id,
          scheduledAt: (() => {
            const offsetDays = plan.status === 'won' ? -2 : 1 + (i % 4);
            const ist = new Date(now + 5.5 * H + offsetDays * 24 * H);
            return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), i % 2 ? 11 : 16) - 5.5 * H);
          })(),
          status: plan.status === 'won' ? 'completed' : 'scheduled', updatedAt: new Date(), createdAt: new Date(created.getTime() + 2.1 * H),
        },
      });
    }
  }
  console.log(`Demo data: ${NAMES.length} leads with WhatsApp chats, AI calls, follow-ups, visits and handoffs in "${dbName}".`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

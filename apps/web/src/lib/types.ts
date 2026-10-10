export type Customer = {
  id: string;
  name: string | null;
  phone: string | null;
  email?: string | null;
  language?: string | null;
  source?: string | null;
  location?: string | null;
  budget?: string | number | null;
  bhk?: number | null;
  propertyType?: string | null;
  purchaseTimeline?: string | null;
  objections?: string | null;
  interestedPropertyId?: string | null;
  callbackAt?: string | null;
  doNotContact?: boolean;
  lastInboundAt?: string | null;
  createdAt?: string;
};

export type Lead = {
  id: string;
  customerId: string;
  status: string;
  budget: string | number | null;
  location: string | null;
  bhk: number | null;
  propertyType: string | null;
  source: string | null;
  campaign?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
  customer?: Customer;
};

export type FollowUp = {
  id: string;
  leadId: string;
  customerId: string;
  channel: string;
  action: string;
  message: string | null;
  scheduledAt: string;
  status: string;
  attempts: number;
  cancellationReason: string | null;
  source: string;
  lastError: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  customer?: Pick<Customer, 'id' | 'name' | 'phone'>;
  lead?: Pick<Lead, 'id' | 'status' | 'location' | 'bhk' | 'propertyType' | 'budget'>;
};

export type Call = {
  id: string;
  leadId: string | null;
  customerId: string;
  direction: string;
  status: string;
  outcome: string | null;
  toNumber: string;
  fromNumber: string;
  attempt: number;
  turns: number;
  language: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  hangupCause: string | null;
  summary?: string | null;
  createdAt: string;
  customer?: Customer;
  lead?: Lead | null;
};

export type Message = {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: string;
  metadata?: Record<string, unknown> | null;
};

export type Conversation = {
  id: string;
  channel: string;
  externalId: string | null;
  customerId: string | null;
  updatedAt: string;
  customer: (Customer & { lead: Lead | null }) | null;
  lastMessage: Message | null;
  messageCount: number;
};

export type Property = { id: string; name: string; location: string; bhk: number; type: string; price: string | number };

export type SiteVisit = {
  id: string;
  leadId: string;
  customerId: string;
  propertyId: string;
  scheduledAt: string;
  status: string;
  notes: string | null;
  createdAt: string;
  Customer?: Customer;
  Property?: Property;
};

export type LeadDetail = {
  lead: Lead & { customer: Customer };
  followUps: FollowUp[];
  calls: Call[];
  siteVisits: SiteVisit[];
  conversations: Array<{ id: string; channel: string; messages: Message[] }>;
  otherLeads: Array<{ id: string; status: string; createdAt: string; source: string | null }>;
};

export type Summary = {
  days: number;
  leads: {
    total: number;
    newToday: number;
    inRange: number;
    prevRange: number;
    byStatus: Record<string, number>;
    bySource: Record<string, number>;
    qualified: number;
    conversions: number;
  };
  funnel: Array<{ stage: string; count: number }>;
  whatsapp: { conversations: number; inboundMessages: number };
  ai: { replies: number };
  voice: {
    total: number;
    prevRange: number;
    connected: number;
    unanswered: number;
    failed: number;
    live: number;
    avgDurationSec: number;
    outcomes: Record<string, number>;
  };
  siteVisits: { total: number; inRange: number };
  humanTasksOpen: number;
  followUpsPending: number;
  series: Array<{ day: string; leads: number; calls: number; connectedCalls: number; whatsapp: number }>;
};

export type ActivityEvent = {
  type: 'lead' | 'call' | 'followup' | 'handoff' | 'visit' | 'message';
  at: string;
  customer: Pick<Customer, 'id' | 'name' | 'phone'> | null;
  leadId: string | null;
  detail: string;
  callId?: string;
};

export type Roi = {
  days: number;
  leads: number;
  speedToFirstCall: { medianSec: number | null; p90Sec: number | null; within2MinPct: number | null; called: number };
  rates: { contactPct: number | null; qualifiedPct: number | null; bookingPct: number | null; showUpPct: number | null };
  /** Denominator behind each rate (absent on older API versions). */
  samples?: { contact: number; qualified: number; booking: number; showUp: number; speed: number; minSample: number };
  funnel: Array<{ stage: string; count: number }>;
  costs: {
    adSpendInr: number;
    voiceInr: number;
    whatsappInr: number;
    totalInr: number;
    perLeadInr: number | null;
    perAttendedVisitInr: number | null;
    inputs: { costPerLeadInr: number; voiceCostPerMinuteInr: number; whatsappCostPerMessageInr: number };
  };
  usage: { connectedMinutes: number; whatsappSent: number; calls: number };
  byCampaign: Array<{ name: string; leads: number; reached: number; booked: number; attended: number; costPerAttendedInr: number | null }>;
};

export type TenantSettings = {
  speedToLead: { instantCall: boolean; callDelayMinutes: number };
  calling: { windowStartHour: number; windowEndHour: number; maxAttempts: number; retryAfterMinutes: number; nextDayRetryHour: number };
  nurture: { missedCallWhatsApp: boolean; followUpDays: number[] };
  visits: { confirmDayBefore: boolean; reminderHoursBefore: number; teamAlertMinutesBefore: number; afterVisit: boolean; sites: Record<string, { address?: string; mapUrl?: string }> };
  team: { alertPhones: string[]; alertOnBooking: boolean; alertOnHotLead: boolean; alertTemplate: string };
  hotLead: { enabled: boolean; maxTimelineDays: number };
  roi: { costPerLeadInr: number; voiceCostPerMinuteInr: number; whatsappCostPerMessageInr: number };
};

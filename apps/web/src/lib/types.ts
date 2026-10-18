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
  /** Why the call ended (customer_goodbye, max_turns, handoff, no_response, ...). */
  endReason?: string | null;
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
  /** WhatsApp messages we sent: accepted | sent | delivered | read | failed | unknown (from Meta's receipts). */
  deliveryStatus?: string | null;
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
  industry: 'real_estate' | 'textile' | 'retail' | 'manufacturing' | 'agency' | 'food' | 'hotel' | 'hospital';
  food: { taxPct: number; packagingFee: number; pickupEnabled: boolean; deliveryEnabled: boolean; deliveryZones: Array<{ name: string; keywords: string[]; fee: number; minOrder: number; etaMinutes: number }>; faqs: Array<{ q: string; a: string }> };
  hotel: { checkInTime: string; checkOutTime: string; taxPct: number; autoConfirm: boolean; holdMinutes: number; depositPct: number; freeCancellationHours: number; cancellationPolicy: string; maxNights: number; faqs: Array<{ q: string; a: string }> };
  hospital: { emergencyNumber: string; bookingWindowDays: number; reminderHoursBefore: number; faqs: Array<{ q: string; a: string }> };
  textile: { quoteReminderDays: number; feedbackAfterHours: number; notifyOrderStatus: boolean; maxDiscountPct: number };
  finance: { paymentTermsDays: number; dispatchPaymentRule: 'none' | 'any_verified' | 'full'; autoDraftInvoice: boolean };
  agents: { paused: string[] };
};

// ---------------------------------------------------------------- textile (industry = textile)

/** Prisma Decimal fields arrive as strings. */
type Money = string | number;
type Person = { id: string; name: string | null; phone: string | null };

export type TextileProduct = {
  id: string; sku: string; name: string; fabricCategory: string; composition: string | null; gsm: number | null; width: string | null;
  colour: string | null; design: string | null; sizes: string | null; moq: number | null; priceUnit: string; currency: string;
  price: Money | null; priceApproved: boolean; stockStatus: string; imageUrls: string[] | null; catalogueUrl: string | null;
  leadTimeDays: number | null; active: boolean; updatedAt: string;
};

export type QuotationItem = { id: string; productId: string | null; sku: string | null; description: string; quantity: Money; unit: string; unitPrice: Money; lineTotal: Money };

export type AuditEvent = { id: string; actor: string; action: string; data: Record<string, unknown> | null; createdAt: string };

export type Quotation = {
  id: string; number: string; status: string; origin: string; currency: string; customerId: string; leadId: string | null;
  subtotal: Money; discount: Money; taxPercent: Money; tax: Money; shipping: Money; total: Money;
  validUntil: string | null; paymentTerms: string | null; deliveryTerms: string | null; salesperson: string | null; notes: string | null;
  sentAt: string | null; decidedAt: string | null; createdAt: string;
  customer: Person | null; items: QuotationItem[]; order: { id: string; number: string; status: string } | null; audit?: AuditEvent[];
};

export type SalesOrder = {
  id: string; number: string; status: string; paymentStatus: string; currency: string; total: Money; customerId: string; leadId: string | null;
  expectedDelivery: string | null; shippingAddress: string | null; deliveredAt: string | null; createdAt: string;
  customer: Person | null; items: QuotationItem[]; quotation: { id: string; number: string } | null; feedback: Feedback | null; audit?: AuditEvent[];
};

export type Feedback = {
  id: string; status: string; rating: number | null; comment: string | null; owner: string | null; resolution: string | null;
  requestedAt: string; receivedAt: string | null; resolvedAt: string | null; customer?: Person | null; order?: { id: string; number: string } | null;
};

export type TextileOverview = {
  days: number;
  catalogue: { activeProducts: number };
  leads: { total: number };
  quotations: { sent: number; accepted: number; acceptRatePct: number | null };
  orders: { confirmed: number; pendingConfirmation: number; cancelled: number; recordedRevenue: number; paidRevenue: number; leadToOrderPct: number | null; quoteToOrderPct: number | null };
  calls: { attempted: number; answered: number; notAnswered: number; answerRatePct: number | null; avgDurationSec: number | null };
  feedback: { requested: number; received: number; avgRating: number | null; needsAction: number };
  tasks: { openHandoffs: number };
  meta: { spendAvailable: boolean; reason: string; costPerLeadEstimateInr: number };
  definitions: Record<string, string>;
  sales: { qualifiedEnquiries: number; quotationsCreated: number; quotationsAwaitingResponse: number };
  operations: { trackedProducts: number; lowStock: number; outOfStock: number; reservedUnits: number; ordersAwaitingFulfilment: number; dispatched: number; delayedOrders: number; openProcurementTasks: number };
  agents: { tasksCompleted: number; tasksFailed: number; pendingApprovals: number; openTeamTasks: number; modelCalls: number };
  marketing?: { campaignsSent: number; attributedEnquiries: number; attributedQuotations: number; attributedOrders: number; attributedVerifiedCollections: number };
  finance: { invoiced: number; collectedVerified: number; outstanding: number; overdue: number; overdueInvoices: number; paymentsAwaitingVerification: number; reconciliationExceptions: number };
};

// ---------------------------------------------------------------- AI agents + operations

export type AgentName = 'marketing' | 'sales' | 'finance' | 'operations';

export type AgentSummary = {
  name: AgentName; label: string; purpose: string; tools: string[]; implemented: string[]; notYetBuilt: string[]; paused: boolean;
  kinds: Array<{ kind: string; agent: AgentName; label: string; description: string; userRunnable: boolean }>;
  last30Days: { completed: number; failed: number; running: number; pending: number; needsApproval: number; cancelled: number };
  recentErrors: Array<{ id: string; kind: string; error: string | null; updatedAt: string }>;
  aiCost: { taskModelCalls: number; note: string };
};

export type AgentTaskEvent = { id: string; type: string; message: string; data: Record<string, unknown> | null; createdAt: string };

export type AgentTask = {
  id: string; agent: AgentName; kind: string; trigger: string; status: string; idempotencyKey: string; entityType: string | null; entityId: string | null;
  input: Record<string, unknown> | null; result: Record<string, unknown> | null; error: string | null; attempts: number; maxAttempts: number;
  parentTaskId: string | null; depth: number; approvalId: string | null; requestedBy: string; runAfter: string | null; startedAt: string | null; finishedAt: string | null; createdAt: string;
  events?: AgentTaskEvent[];
  children?: Array<{ id: string; agent: AgentName; kind: string; status: string }>;
  parent?: { id: string; agent: AgentName; kind: string; status: string } | null;
};

export type Approval = {
  id: string; action: string; entityType: string; entityId: string; requestedBy: string; reason: string; payload: Record<string, unknown>;
  requiredPermission: string; status: string; decidedBy: string | null; decidedAt: string | null; decisionNote: string | null; expiresAt: string | null;
  executedAt: string | null; executionResult: Record<string, unknown> | null; taskId: string | null; createdAt: string;
};

export type WorkTask = {
  id: string; agent: AgentName; kind: string; title: string; detail: string | null; status: string; priority: string; assignee: string | null; dueAt: string | null;
  entityType: string | null; entityId: string | null; resolution: string | null; createdBy: string; completedAt: string | null; createdAt: string;
};

export type Integration = { name: string; status: 'configured' | 'not_configured' | 'blocked' | 'not_connected' | 'unknown' | 'not_built'; note: string };

export type StockRow = {
  productId: string; sku: string; name: string; unit: string; fabricCategory: string; colour: string | null; leadTimeDays: number | null; tracked: boolean;
  locations: Array<{ location: string; onHand: number; reserved: number }>; onHand: number; reserved: number; available: number; lowStockAt: number | null; low: boolean;
};

export type StockMovement = {
  id: string; productId: string; location: string; type: string; quantity: string | number; onHandAfter: string | number; reservedAfter: string | number;
  orderId: string | null; lot: string | null; reference: string | null; reason: string | null; actor: string; createdAt: string;
  product: { name: string; sku: string; priceUnit: string };
};

export type FulfilmentRow = {
  id: string; number: string; status: string; paymentStatus: string; total: string | number; expectedDelivery: string | null; delayed: boolean;
  customer: { name: string | null; phone: string | null } | null;
  stock: { fullyReserved: boolean; untrackedItems: number; lines: Array<{ productId: string; name: string; unit: string; tracked: boolean; needed: number; reserved: number; dispatched: number; available: number; unitMismatch: boolean }> };
};

export type OperationsOverview = {
  products: { tracked: number; untracked: number; low: number; outOfStock: number };
  reservedUnits: number;
  orders: { awaitingFulfilment: number; dispatched: number; delayed: number };
  openTasks: Record<string, number>;
  note: string;
};

// ---------------------------------------------------------------- finance

export type Payment = {
  id: string; invoiceId: string | null; orderId: string | null; customerId: string; amount: string | number; currency: string; method: string;
  reference: string | null; transactionId: string | null; paidAt: string; status: string; source: string; verificationSource: string | null; evidence: string | null;
  enteredBy: string; verifiedBy: string | null; verifiedAt: string | null; rejectedReason: string | null; reversedAt: string | null; reversalReason: string | null; notes: string | null; createdAt: string;
  invoice?: { id: string; number: string; total: string | number; amountPaid: string | number; status: string } | null;
  customer?: { name: string | null; phone: string | null } | null;
};

export type Invoice = {
  id: string; number: string; orderId: string; customerId: string; status: string; currency: string; invoiceDate: string | null; dueDate: string | null;
  subtotal: string | number; discount: string | number; taxPercent: string | number; tax: string | number; shipping: string | number; total: string | number; amountPaid: string | number;
  taxSource: string; notes: string | null; createdAt: string; cancelReason: string | null;
  outstanding: number; daysOverdue: number; overdue: boolean;
  customer: { id: string; name: string | null; phone: string | null } | null;
  order: { id: string; number: string; status: string } | null;
  items?: Array<{ id: string; sku: string | null; description: string; quantity: string | number; unit: string; unitPrice: string | number; lineTotal: string | number }>;
  payments?: Payment[];
  audit?: AuditEvent[];
};

export type Receivables = {
  invoices: Invoice[];
  aging: Record<'current' | '1_30' | '31_60' | '61_90' | 'over_90', number>;
  customers: Array<{ customerId: string; name: string | null; phone: string | null; invoices: number; outstanding: number; overdue: number }>;
  asOf: string;
};

export type FinanceOverview = {
  days: number;
  orderValue: { amount: number; count: number };
  invoiced: { amount: number; count: number };
  collectedVerified: { amount: number; count: number };
  outstanding: { amount: number; count: number };
  overdue: { amount: number; count: number };
  awaitingVerification: { amount: number; count: number };
  reconciliationExceptions: number;
  expenses: { amount: number; count: number };
  grossMargin: null;
  notes: Record<string, string>;
};

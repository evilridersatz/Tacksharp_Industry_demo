import type { AgentDefinition, AgentName } from './agent-types.js';

/**
 * The four agents, their tool permissions, and an honest list of what each one does today.
 * The Sales agent's customer conversations are the existing textile WhatsApp / voice assistant
 * (conversation-engine textilePlan); here it gets typed tasks that use the same records.
 */
export const AGENTS: Record<AgentName, AgentDefinition> = {
  sales: {
    name: 'sales',
    label: 'Sales agent',
    purpose: 'Answers textile enquiries from the approved catalogue, records requirements and quotation requests, checks real stock before anything is promised.',
    tools: ['catalogue.read', 'inventory.read', 'quotations.read', 'orders.read', 'worktask.create'],
    implemented: [
      'WhatsApp / voice textile enquiries from the approved catalogue (existing assistant)',
      'Quotation requests, acceptance, order hand-over (existing textile sales)',
      'Stock availability check against counted stock',
      'Stock-shortage review task for the salesperson (no unsupported promise)',
      'Exceptional discounts go to the approval queue',
      'Stock-shortage decision by the owner (revised date / alternative / partial / cancel) with an approved customer message',
      'Customer receipt after a VERIFIED payment (queued; opt-out, 24 h window, template and DRY_RUN apply)',
      'STOP / START on WhatsApp: opt-out recorded at once, every scheduled message and AI call cancelled, confirmed with a fixed reply (never a sales answer)',
    ],
    notYetBuilt: [],
  },
  operations: {
    name: 'operations',
    label: 'Operations agent',
    purpose: 'Keeps counted stock, reserves it for confirmed orders, deducts it on dispatch, and raises shortage and low-stock tasks.',
    tools: ['inventory.read', 'inventory.reserve', 'inventory.release', 'inventory.dispatch', 'orders.read', 'worktask.create', 'quality.read'],
    implemented: [
      'Stock tracking per product (on hand, reserved, available) with movement history',
      'Reserve on order confirmation (all-or-nothing), release on cancellation, deduct on dispatch',
      'Blocks "ready to dispatch" / "dispatched" until tracked stock is reserved',
      'Shortage exception + procurement tasks; low-stock scan',
      'Order fulfilment check',
      'Dispatch with courier / tracking number (included in the customer update)',
      'Manufacturing: quality summary and quality alert scan from recorded inspections (corrective-action tasks)',
    ],
    notYetBuilt: ['Production / processing queue', 'Supplier purchase orders', 'Lot / batch allocation', 'Courier tracking integration (tracking numbers are recorded, not followed)'],
  },
  finance: {
    name: 'finance',
    label: 'Finance agent',
    purpose: 'Drafts invoices from confirmed orders, tracks payments that people verify with evidence, reconciliation exceptions, receivables and overdue follow-ups.',
    tools: ['orders.read', 'quotations.read', 'invoices.read', 'invoices.write', 'payments.read', 'worktask.create'],
    implemented: [
      'Invoice draft when an order is confirmed (from the quotation terms; a person approves and issues)',
      'Payments recorded as "pending verification"; verified only by an authorised person with evidence',
      'Duplicate-reference and overpayment exceptions; reversal only through an approval',
      'Payment verified → invoice / order payment status → dispatch payment rule → Operations',
      'Receivables, aging and overdue scan (follow-up tasks)',
      'Payment reminders: prepared by the agent, sent only after approval (finance.send_reminder); stopped when paid, disputed or promised',
      'Payment promises (kept / broken), disputes (pause reminders) and collection outcomes',
      'Bank statement matching (read-only): unmatched, mismatched and missing transactions become exceptions',
      'Expenses (voided, never deleted); gross margin only where product unit cost is recorded',
    ],
    notYetBuilt: ['Payment gateway / bank feed (not connected)', 'Accounting integration (Tally / Zoho Books: not connected)', 'Refunds (never automatic; not built)'],
  },
  marketing: {
    name: 'marketing',
    label: 'Marketing agent',
    purpose: 'Drafts campaigns and content from the catalogue, asks for approval before any customer is messaged, and reports what campaigns and lead sources produced.',
    tools: ['leads.read', 'quotations.read', 'orders.read', 'catalogue.read', 'segments.read', 'campaigns.read', 'campaigns.write', 'campaigns.send', 'content.write'],
    implemented: [
      'Enquiries → quotations → orders by source / campaign (recorded values; no ad spend)',
      'Campaign briefs and WhatsApp drafts from the catalogue (approved prices only)',
      'Customer segments (tags, language, lead status / source, recent activity) - always limited to customers with marketing consent who did not opt out',
      'Customer list import (CSV / Excel) with consent column + suppression list',
      'Campaign approval queue: sends only the approved content to at most the approved audience; DRY_RUN = simulated',
      'Content calendar: drafted posts → approval → published by a person (recorded)',
      'AI captions, promos, Reels scripts and broadcasts (English / Tamil / Tanglish) from approved catalogue facts; unsupported claims removed; every revision kept',
      'Campaign report: delivered / read / replied → leads → quotations → orders',
    ],
    notYetBuilt: ['Meta ad spend and ad ROI (needs ads_read, checked live; reporting not built)', 'Auto-posting to Instagram / Facebook (no social account connected)'],
  },
};

export const MAX_HANDOFF_DEPTH = 3;

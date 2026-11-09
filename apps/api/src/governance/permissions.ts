import { ForbiddenException } from '@nestjs/common';

/**
 * Role -> permissions. Checked on the server for every restricted action; hiding a button is never the control.
 * Existing users are all `admin` (the default role), so nothing changes for them. Other roles are opt-in.
 */
export const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: ['*'],
  manager: ['inbox.*', 'integrations.view', 'customers.*', 'sales.*', 'operations.*', 'marketing.*', 'agents.view', 'agents.run', 'agents.manage', 'orders.*', 'bookings.*', 'clinic.*', 'insurance.view', 'monitoring.*', 'office.view', 'office.run', 'office.approve'],
  sales: ['inbox.view', 'inbox.reply', 'customers.view', 'customers.manage', 'sales.view', 'agents.view', 'agents.run', 'finance.record_payment'],
  operations: ['inbox.view', 'customers.view', 'operations.view', 'operations.receive_stock', 'operations.manage_tasks', 'operations.dispatch', 'agents.view', 'agents.run', 'orders.*', 'monitoring.view', 'monitoring.operate'],
  // Hotel front desk: reservations, check-in / check-out, room status.
  front_desk: ['inbox.view', 'inbox.reply', 'customers.view', 'customers.manage', 'bookings.*', 'agents.view', 'agents.run'],
  // Hospital reception: appointments and patient enquiries; insurance desk: insurance cases (decisions recorded from the insurer).
  reception: ['inbox.view', 'inbox.reply', 'customers.view', 'customers.manage', 'clinic.*', 'insurance.view', 'agents.view', 'agents.run'],
  insurance: ['customers.view', 'insurance.*', 'clinic.view', 'agents.view'],
  // VisionOps field technician / NOC operator: sees devices and incidents, acknowledges and works them.
  technician: ['monitoring.view', 'monitoring.operate', 'agents.view'],
  finance: ['customers.view', 'finance.*', 'agents.view', 'agents.run'],
  // Marketing staff draft, import, segment and approve content; sending to customers needs marketing.approve_campaign
  // (admin / manager), so every campaign passes through the approval queue.
  marketing: ['inbox.view', 'customers.view', 'customers.manage', 'marketing.view', 'marketing.manage', 'marketing.approve_content', 'agents.view', 'agents.run'],
  // Operator: day-to-day work across the workspace's modules (customers, orders, bookings, appointments, stock,
  // monitoring incidents), no people / settings / integrations / finance approvals.
  operator: ['inbox.view', 'inbox.reply', 'customers.view', 'customers.manage', 'sales.view', 'operations.view', 'operations.receive_stock', 'operations.manage_tasks', 'operations.dispatch', 'orders.*', 'bookings.view', 'bookings.manage', 'clinic.view', 'clinic.manage', 'monitoring.view', 'monitoring.operate', 'marketing.view', 'agents.view', 'agents.run'],
  // Read-only demo / stakeholder access: views the workspace; every write is refused by the auth guard.
  viewer: ['office.view', 'inbox.view', 'customers.view', 'sales.view', 'operations.view', 'marketing.view', 'agents.view', 'bookings.view', 'clinic.view', 'insurance.view', 'monitoring.view', 'finance.view', 'orders.view'],
  // Team lead: runs the team inbox (assigns, labels, saved replies), the CRM and campaigns drafts; no settings / people.
  team_lead: ['inbox.*', 'customers.*', 'sales.view', 'marketing.view', 'marketing.manage', 'orders.view', 'bookings.view', 'agents.view', 'agents.run'],
  // Support agent: answers customers in the inbox and keeps their records; no campaigns, no settings.
  support: ['inbox.view', 'inbox.reply', 'customers.view', 'customers.manage', 'orders.view', 'bookings.view', 'agents.view'],
  // Read-only analyst: sees everything a viewer sees (writes refused by the auth guard).
  analyst: ['office.view', 'inbox.view', 'customers.view', 'sales.view', 'operations.view', 'marketing.view', 'agents.view', 'bookings.view', 'clinic.view', 'insurance.view', 'monitoring.view', 'finance.view', 'orders.view'],
};

export const PERMISSIONS = {
  /** Team inbox: read conversations, notes and the customer panel. */
  inboxView: 'inbox.view',
  /** Reply to customers, take over from / return to the AI, add notes, change status of own conversations. */
  inboxReply: 'inbox.reply',
  /** Assign to others, labels, priority, saved replies, round-robin. */
  inboxManage: 'inbox.manage',
  customersView: 'customers.view',
  /** Add / edit customers and record consent. */
  customersManage: 'customers.manage',
  /** Send a WhatsApp test or place a test call (still consent- and live-gated): admin / manager only. */
  customersContact: 'customers.contact',
  /** Invite people, change roles, remove access, issue password-reset links (workspace admin only). */
  usersManage: 'users.manage',
  /** Provider credentials (Plivo, Sarvam, OpenAI, WhatsApp): save, test, enable / disable. Organization admin only. */
  integrationsManage: 'integrations.manage',
  /** See integration status and usage (masked; never secrets). */
  integrationsView: 'integrations.view',
  approveDiscount: 'sales.approve_discount',
  adjustStock: 'operations.adjust_stock',
  receiveStock: 'operations.receive_stock',
  manageOpsTasks: 'operations.manage_tasks',
  agentsView: 'agents.view',
  agentsRun: 'agents.run',
  agentsManage: 'agents.manage',
  financeView: 'finance.view',
  createInvoice: 'finance.create_invoice',
  approveInvoice: 'finance.approve_invoice',
  recordPayment: 'finance.record_payment',
  verifyPayment: 'finance.verify_payment',
  reversePayment: 'finance.reverse_payment',
  sendReminder: 'finance.send_reminder',
  manageExpenses: 'finance.manage_expenses',
  decideShortage: 'sales.decide_shortage',
  dispatchOrder: 'operations.dispatch',
  marketingView: 'marketing.view',
  marketingManage: 'marketing.manage',
  approveCampaign: 'marketing.approve_campaign',
  approveContent: 'marketing.approve_content',
  manageFoodOrders: 'orders.manage',
  manageMenu: 'orders.manage_menu',
  manageBookings: 'bookings.manage',
  manageRooms: 'bookings.manage_rooms',
  /** Read appointments and patients (phones / visit reasons masked unless the role also manages the clinic). */
  viewClinic: 'clinic.view',
  manageClinic: 'clinic.manage',
  manageDoctors: 'clinic.manage_doctors',
  viewInsurance: 'insurance.view',
  manageInsurance: 'insurance.manage',
  recordInsuranceDecision: 'insurance.record_decision',
  monitoringView: 'monitoring.view',
  /** Acknowledge, assign, work and resolve incidents. */
  monitoringOperate: 'monitoring.operate',
  /** Customers, sites, devices, technicians, agents (tokens), contracts, settings. */
  monitoringManage: 'monitoring.manage',
  /** AI Office: see the floor, plans, tasks, approvals, usage and audit. */
  officeView: 'office.view',
  /** AI Office: give the CEO instructions, start / pause / cancel plans, retry or accept tasks. */
  officeRun: 'office.run',
  /** AI Office: settings, agent configurations, workflows, memory. */
  officeManage: 'office.manage',
  /** AI Office: approve or reject an agent's sensitive action (customer messages and other mandatory approvals). */
  officeApprove: 'office.approve',
} as const;

export function can(role: string | undefined, permission: string): boolean {
  const granted = ROLE_PERMISSIONS[role ?? ''] ?? [];
  return granted.some((g) => g === '*' || g === permission || (g.endsWith('.*') && permission.startsWith(g.slice(0, -1))));
}

export function requirePermission(user: { role?: string } | undefined, permission: string) {
  if (!can(user?.role, permission)) throw new ForbiddenException(`You need the "${permission}" permission for this.`);
}

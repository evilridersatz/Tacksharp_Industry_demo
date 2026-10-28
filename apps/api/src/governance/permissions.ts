import { ForbiddenException } from '@nestjs/common';

/**
 * Role -> permissions. Checked on the server for every restricted action; hiding a button is never the control.
 * Existing users are all `admin` (the default role), so nothing changes for them. Other roles are opt-in.
 */
export const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: ['*'],
  manager: ['customers.*', 'sales.*', 'operations.*', 'marketing.*', 'agents.view', 'agents.run', 'agents.manage', 'orders.*', 'bookings.*', 'clinic.*', 'insurance.view', 'monitoring.*'],
  sales: ['customers.view', 'customers.manage', 'sales.view', 'agents.view', 'agents.run', 'finance.record_payment'],
  operations: ['customers.view', 'operations.view', 'operations.receive_stock', 'operations.manage_tasks', 'operations.dispatch', 'agents.view', 'agents.run', 'orders.*', 'monitoring.view', 'monitoring.operate'],
  // Hotel front desk: reservations, check-in / check-out, room status.
  front_desk: ['customers.view', 'customers.manage', 'bookings.*', 'agents.view', 'agents.run'],
  // Hospital reception: appointments and patient enquiries; insurance desk: insurance cases (decisions recorded from the insurer).
  reception: ['customers.view', 'customers.manage', 'clinic.*', 'insurance.view', 'agents.view', 'agents.run'],
  insurance: ['customers.view', 'insurance.*', 'clinic.view', 'agents.view'],
  // VisionOps field technician / NOC operator: sees devices and incidents, acknowledges and works them.
  technician: ['monitoring.view', 'monitoring.operate', 'agents.view'],
  finance: ['customers.view', 'finance.*', 'agents.view', 'agents.run'],
  // Marketing staff draft, import, segment and approve content; sending to customers needs marketing.approve_campaign
  // (admin / manager), so every campaign passes through the approval queue.
  marketing: ['customers.view', 'customers.manage', 'marketing.view', 'marketing.manage', 'marketing.approve_content', 'agents.view', 'agents.run'],
  // Read-only demo / stakeholder access: views the workspace; every write is refused by the auth guard.
  viewer: ['customers.view', 'sales.view', 'operations.view', 'marketing.view', 'agents.view', 'bookings.view', 'clinic.view', 'insurance.view', 'monitoring.view', 'finance.view', 'orders.view'],
};

export const PERMISSIONS = {
  customersView: 'customers.view',
  /** Add / edit customers and record consent. */
  customersManage: 'customers.manage',
  /** Send a WhatsApp test or place a test call (still consent- and live-gated): admin / manager only. */
  customersContact: 'customers.contact',
  /** Invite people, change roles, remove access, issue password-reset links (workspace admin only). */
  usersManage: 'users.manage',
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
} as const;

export function can(role: string | undefined, permission: string): boolean {
  const granted = ROLE_PERMISSIONS[role ?? ''] ?? [];
  return granted.some((g) => g === '*' || g === permission || (g.endsWith('.*') && permission.startsWith(g.slice(0, -1))));
}

export function requirePermission(user: { role?: string } | undefined, permission: string) {
  if (!can(user?.role, permission)) throw new ForbiddenException(`You need the "${permission}" permission for this.`);
}

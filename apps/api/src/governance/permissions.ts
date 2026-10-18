import { ForbiddenException } from '@nestjs/common';

/**
 * Role -> permissions. Checked on the server for every restricted action; hiding a button is never the control.
 * Existing users are all `admin` (the default role), so nothing changes for them. Other roles are opt-in.
 */
export const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: ['*'],
  manager: ['sales.*', 'operations.*', 'marketing.*', 'agents.view', 'agents.run', 'agents.manage', 'orders.*', 'bookings.*', 'clinic.*', 'insurance.view'],
  sales: ['sales.view', 'agents.view', 'agents.run', 'finance.record_payment'],
  operations: ['operations.view', 'operations.receive_stock', 'operations.manage_tasks', 'operations.dispatch', 'agents.view', 'agents.run', 'orders.*'],
  // Hotel front desk: reservations, check-in / check-out, room status.
  front_desk: ['bookings.*', 'agents.view', 'agents.run'],
  // Hospital reception: appointments and patient enquiries; insurance desk: insurance cases (decisions recorded from the insurer).
  reception: ['clinic.*', 'insurance.view', 'agents.view', 'agents.run'],
  insurance: ['insurance.*', 'clinic.view', 'agents.view'],
  finance: ['finance.*', 'agents.view', 'agents.run'],
  // Marketing staff draft, import, segment and approve content; sending to customers needs marketing.approve_campaign
  // (admin / manager), so every campaign passes through the approval queue.
  marketing: ['marketing.view', 'marketing.manage', 'marketing.approve_content', 'agents.view', 'agents.run'],
};

export const PERMISSIONS = {
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
} as const;

export function can(role: string | undefined, permission: string): boolean {
  const granted = ROLE_PERMISSIONS[role ?? ''] ?? [];
  return granted.some((g) => g === '*' || g === permission || (g.endsWith('.*') && permission.startsWith(g.slice(0, -1))));
}

export function requirePermission(user: { role?: string } | undefined, permission: string) {
  if (!can(user?.role, permission)) throw new ForbiddenException(`You need the "${permission}" permission for this.`);
}

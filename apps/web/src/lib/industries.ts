import {
  Activity, BarChart3, Bot, Boxes, Building2, CalendarCheck, ClipboardCheck, Columns3, Factory, FileText, FlaskConical, Gauge, Gift, Headset, Landmark,
  LayoutDashboard, LineChart, ListChecks, Megaphone, MessageSquare, Package, Phone, PlugZap, Settings, Shirt, ShoppingBag, ShoppingCart, Star, Store,
  TrendingUp, UtensilsCrossed, Users, Wrench, type LucideIcon,
} from 'lucide-react';

/**
 * Industry registry (web). The server decides WHICH industry a workspace is (GET /industry/workspace); this file decides
 * how that industry looks: navigation, terminology, accent, settings sections and playground examples. Every nav entry
 * points to a page that exists; nothing here grants access (the API checks every request).
 */
export const INDUSTRY_IDS = ['textile', 'restaurant', 'real_estate', 'retail', 'manufacturing', 'agency'] as const;
export type IndustryId = (typeof INDUSTRY_IDS)[number];

export type NavItem = { href: string; label: string; icon: LucideIcon; badge?: 'live' | 'handoff' | 'orders' };
export type NavGroup = { section: string; items: NavItem[] };

export type IndustryDef = {
  id: IndustryId;
  label: string;
  short: string;
  tagline: string;
  icon: LucideIcon;
  /** Accent used for active nav, KPI tones and chart primary series (contrast-checked on white and on the sidebar). */
  accent: string;
  accentSoft: string;
  /** Accent on the dark sidebar. */
  onDark: string;
  nav: NavGroup[];
  terms: { customer: string; customers: string; lead: string; leads: string; order: string; orders: string; product: string; products: string };
  /** Settings sections that apply (ids used by the Settings page). */
  settings: Array<'industry' | 'speed' | 'calling' | 'nurture' | 'visits' | 'team' | 'roi' | 'textile' | 'finance' | 'restaurant'>;
  search: { placeholder: string; href: string };
};

const SETUP: NavGroup = { section: 'Setup', items: [{ href: '/settings', label: 'Settings', icon: Settings }] };

export const INDUSTRIES: Record<IndustryId, IndustryDef> = {
  textile: {
    id: 'textile', label: 'Textile & Apparel', short: 'Textile', tagline: 'Catalogue, quotations, orders and follow-ups on WhatsApp.', icon: Shirt,
    accent: '#7c3aed', accentSoft: '#f3edff', onDark: '#a78bfa',
    nav: [
      { section: 'Overview', items: [{ href: '/', label: 'Textile overview', icon: LayoutDashboard }, { href: '/textile', label: 'Sales dashboard', icon: Gauge }] },
      { section: 'Sales', items: [
        { href: '/catalogue', label: 'Product catalogue', icon: Package },
        { href: '/operations', label: 'Inventory & stock', icon: Boxes },
        { href: '/leads', label: 'Leads & enquiries', icon: Columns3 },
        { href: '/quotations', label: 'Quotations', icon: FileText },
        { href: '/sales-orders', label: 'Sales orders', icon: ShoppingBag },
        { href: '/feedback', label: 'Customer feedback', icon: Star },
      ] },
      { section: 'Engagement', items: [
        { href: '/marketing?tab=audience', label: 'Customer database', icon: Users },
        { href: '/marketing', label: 'WhatsApp campaigns', icon: Megaphone },
        { href: '/conversations', label: 'Conversations', icon: MessageSquare },
        { href: '/calls', label: 'AI voice calls', icon: Phone, badge: 'live' },
        { href: '/follow-ups', label: 'Follow-ups & reminders', icon: ListChecks },
      ] },
      { section: 'AI & reports', items: [{ href: '/agents', label: 'AI agents', icon: Bot }, { href: '/finance', label: 'Finance', icon: Landmark }, { href: '/analytics', label: 'Reports & analytics', icon: BarChart3 }] },
      SETUP,
    ],
    terms: { customer: 'customer', customers: 'customers', lead: 'enquiry', leads: 'enquiries', order: 'sales order', orders: 'sales orders', product: 'product', products: 'products' },
    settings: ['industry', 'textile', 'finance', 'speed', 'team', 'roi'],
    search: { placeholder: 'Search enquiries…', href: '/leads' },
  },
  restaurant: {
    id: 'restaurant', label: 'Restaurant & Food Service', short: 'Restaurant', tagline: 'WhatsApp ordering, live orders, follow-ups and feedback.', icon: UtensilsCrossed,
    accent: '#ea580c', accentSoft: '#fff1e8', onDark: '#fb923c',
    nav: [
      { section: 'Main', items: [
        { href: '/', label: 'Restaurant overview', icon: LayoutDashboard },
        { href: '/orders', label: 'Orders & tracking', icon: ShoppingBag, badge: 'orders' },
        { href: '/activity', label: 'Live operations', icon: Activity },
        { href: '/conversations', label: 'WhatsApp conversations', icon: MessageSquare, badge: 'handoff' },
        { href: '/customers', label: 'Customers', icon: Users },
      ] },
      { section: 'Menu & growth', items: [
        { href: '/menu', label: 'Menu & stock', icon: UtensilsCrossed },
        { href: '/offers', label: 'Offers & campaigns', icon: Gift },
        { href: '/follow-ups', label: 'Follow-ups & feedback', icon: ListChecks },
      ] },
      { section: 'AI & reports', items: [{ href: '/agents', label: 'AI agents', icon: Bot }, { href: '/test-chat', label: 'Test chat', icon: FlaskConical }, { href: '/analytics', label: 'Sales & analytics', icon: BarChart3 }] },
      { section: 'Setup', items: [{ href: '/integrations', label: 'Settings & integrations', icon: PlugZap }] },
    ],
    terms: { customer: 'customer', customers: 'customers', lead: 'customer', leads: 'customers', order: 'order', orders: 'orders', product: 'menu item', products: 'menu items' },
    settings: ['restaurant'],
    search: { placeholder: 'Search orders…', href: '/orders' },
  },
  real_estate: {
    id: 'real_estate', label: 'Real Estate', short: 'Real estate', tagline: 'Lead qualification, AI calls and site visits.', icon: Building2,
    accent: '#0f9f6e', accentSoft: '#e7f7f0', onDark: '#34d399',
    nav: [
      { section: 'Main', items: [
        { href: '/', label: 'Real estate overview', icon: LayoutDashboard },
        { href: '/leads', label: 'Leads & CRM', icon: Columns3 },
        { href: '/conversations', label: 'WhatsApp conversations', icon: MessageSquare },
        { href: '/calls', label: 'AI voice calls', icon: Phone, badge: 'live' },
        { href: '/site-visits', label: 'Site visits', icon: CalendarCheck },
      ] },
      { section: 'Pipeline', items: [
        { href: '/follow-ups', label: 'Follow-ups', icon: ListChecks },
        { href: '/handoffs', label: 'Human handoff', icon: Headset, badge: 'handoff' },
        { href: '/performance', label: 'Sales pipeline & ROI', icon: TrendingUp },
      ] },
      { section: 'AI & reports', items: [{ href: '/agents', label: 'AI agents', icon: Bot }, { href: '/analytics', label: 'Reports & analytics', icon: BarChart3 }] },
      SETUP,
    ],
    terms: { customer: 'buyer', customers: 'buyers', lead: 'lead', leads: 'leads', order: 'booking', orders: 'bookings', product: 'property', products: 'properties' },
    settings: ['industry', 'speed', 'calling', 'nurture', 'visits', 'team', 'roi'],
    search: { placeholder: 'Search leads…', href: '/leads' },
  },
  retail: {
    id: 'retail', label: 'Retail & E-commerce', short: 'Retail', tagline: 'Catalogue, stock, orders and campaigns.', icon: Store,
    accent: '#0284c7', accentSoft: '#e6f4fb', onDark: '#38bdf8',
    nav: [
      { section: 'Overview', items: [{ href: '/', label: 'Retail overview', icon: LayoutDashboard }] },
      { section: 'Store', items: [
        { href: '/catalogue', label: 'Product catalogue', icon: Package },
        { href: '/operations', label: 'Inventory & stock alerts', icon: Boxes },
        { href: '/sales-orders', label: 'Orders & fulfilment', icon: ShoppingCart },
        { href: '/leads', label: 'Product enquiries', icon: Columns3 },
      ] },
      { section: 'Customers', items: [
        { href: '/marketing?tab=audience', label: 'Customers', icon: Users },
        { href: '/conversations', label: 'Conversations', icon: MessageSquare },
        { href: '/marketing', label: 'Offers & campaigns', icon: Megaphone },
        { href: '/follow-ups', label: 'Follow-ups', icon: ListChecks },
      ] },
      { section: 'AI & reports', items: [{ href: '/agents', label: 'AI agents', icon: Bot }, { href: '/finance', label: 'Finance', icon: Landmark }, { href: '/analytics', label: 'Revenue analytics', icon: BarChart3 }] },
      SETUP,
    ],
    terms: { customer: 'shopper', customers: 'shoppers', lead: 'enquiry', leads: 'enquiries', order: 'order', orders: 'orders', product: 'product', products: 'products' },
    settings: ['industry', 'finance', 'team', 'roi'],
    search: { placeholder: 'Search enquiries…', href: '/leads' },
  },
  manufacturing: {
    id: 'manufacturing', label: 'Manufacturing & Quality', short: 'Manufacturing', tagline: 'Inspections, defects, corrective actions and complaints.', icon: Factory,
    accent: '#475569', accentSoft: '#eef2f6', onDark: '#cbd5e1',
    nav: [
      { section: 'Production', items: [
        { href: '/', label: 'Production overview', icon: LayoutDashboard },
        { href: '/quality', label: 'Inspections & defects', icon: ClipboardCheck },
        { href: '/operations?tab=tasks', label: 'Corrective actions', icon: Wrench },
      ] },
      { section: 'Customers', items: [{ href: '/conversations', label: 'Customer complaints', icon: MessageSquare }, { href: '/handoffs', label: 'Escalations', icon: Headset, badge: 'handoff' }] },
      { section: 'AI & reports', items: [{ href: '/agents', label: 'AI operations agents', icon: Bot }, { href: '/analytics', label: 'Quality analytics', icon: LineChart }] },
      SETUP,
    ],
    terms: { customer: 'customer', customers: 'customers', lead: 'complaint', leads: 'complaints', order: 'batch', orders: 'batches', product: 'product', products: 'products' },
    settings: ['industry', 'team'],
    search: { placeholder: 'Search batches…', href: '/quality' },
  },
  agency: {
    id: 'agency', label: 'Marketing Agency / Business', short: 'Agency', tagline: 'Leads, campaigns, follow-ups and conversion reporting.', icon: Megaphone,
    accent: '#db2777', accentSoft: '#fdeef5', onDark: '#f472b6',
    nav: [
      { section: 'Main', items: [
        { href: '/', label: 'Business overview', icon: LayoutDashboard },
        { href: '/leads', label: 'Lead management', icon: Columns3 },
        { href: '/conversations', label: 'Customer engagement', icon: MessageSquare },
        { href: '/follow-ups', label: 'Follow-up automation', icon: ListChecks },
        { href: '/handoffs', label: 'Team handoffs', icon: Headset, badge: 'handoff' },
      ] },
      { section: 'Campaigns', items: [
        { href: '/marketing', label: 'Campaign management', icon: Megaphone },
        { href: '/marketing?tab=audience', label: 'Contacts & segments', icon: Users },
        { href: '/marketing?tab=performance', label: 'ROI reporting', icon: TrendingUp },
      ] },
      { section: 'AI & reports', items: [{ href: '/agents', label: 'AI agents', icon: Bot }, { href: '/analytics', label: 'Conversion analytics', icon: BarChart3 }] },
      SETUP,
    ],
    terms: { customer: 'contact', customers: 'contacts', lead: 'lead', leads: 'leads', order: 'deal', orders: 'deals', product: 'service', products: 'services' },
    settings: ['industry', 'team', 'roi'],
    search: { placeholder: 'Search leads…', href: '/leads' },
  },
};

export const industryDef = (id: string | undefined | null): IndustryDef => INDUSTRIES[(INDUSTRY_IDS as readonly string[]).includes(id ?? '') ? (id as IndustryId) : 'real_estate'];

/** Industries that use the shared catalogue / sales-order pages. */
export const CATALOGUE_INDUSTRIES: IndustryId[] = ['textile', 'retail'];
/** Industries where the back-office agents (Agent Centre tasks, approvals, team tasks) run. */
export const ORCHESTRATED_INDUSTRIES: IndustryId[] = ['textile', 'retail', 'manufacturing', 'agency'];

/** Every href in an industry's navigation (tests / guards). */
export const navHrefs = (id: IndustryId) => INDUSTRIES[id].nav.flatMap((g) => g.items.map((i) => i.href.split('?')[0]));

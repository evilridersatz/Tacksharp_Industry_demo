import {
  Activity, BarChart3, Bot, Boxes, Building2, CalendarCheck, ClipboardCheck, Columns3, Factory, FileText, FlaskConical, Gauge, Gift, Headset, Landmark,
  Cpu, LayoutDashboard, LineChart, ListChecks, Megaphone, MessageSquare, Package, Phone, PlugZap, Settings, Shirt, ShoppingBag, ShoppingCart, Star, Store,
  TrendingUp, UtensilsCrossed, Users, Wrench, BedDouble, CalendarDays, ConciergeBell, Database, DoorOpen, HeartPulse, PlayCircle, ShieldCheck, Stethoscope, UserRound,
  Cctv, Siren, MapPin, UserCog, BellRing, FileBarChart, Calculator, type LucideIcon, AudioLines } from 'lucide-react';

/**
 * Industry registry (web). The server decides WHICH industry a workspace is (GET /industry/workspace); this file decides
 * how that industry looks: navigation, terminology, accent, settings sections and playground examples. Every nav entry
 * points to a page that exists; nothing here grants access (the API checks every request).
 */
export const INDUSTRY_IDS = ['textile', 'restaurant', 'food', 'hotel', 'hospital', 'cctv', 'real_estate', 'retail', 'manufacturing', 'agency'] as const;
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
  settings: Array<'industry' | 'speed' | 'calling' | 'nurture' | 'visits' | 'team' | 'roi' | 'textile' | 'finance' | 'restaurant' | 'food' | 'hotel' | 'hospital' | 'monitoring'>;
  search: { placeholder: string; href: string };
};

/** Every workspace: settings, the demo data explorer and the safe scenario runner. */
const WORKSPACE_TOOLS: NavItem[] = [
  { href: '/voice-agents', label: 'Voice agents', icon: AudioLines },
  { href: '/demo-data', label: 'Data & APIs', icon: Database },
  { href: '/scenarios', label: 'Scenario runner', icon: PlayCircle },
  { href: '/team', label: 'Team & access', icon: UserCog },
  { href: '/settings/integrations', label: 'Integrations', icon: PlugZap },
  { href: '/settings/ai-providers', label: 'AI providers', icon: Cpu },
  { href: '/settings/diagnostics', label: 'System health', icon: Activity },
];
const SETUP: NavGroup = { section: 'Setup', items: [{ href: '/settings', label: 'Settings', icon: Settings }, ...WORKSPACE_TOOLS] };

/** Product family a workspace belongs to. One login and one API; the family only changes the switcher grouping and the brand line. */
export type ProductFamily = 'agents' | 'visionops';
export const PRODUCT_LABEL: Record<ProductFamily, string> = { agents: 'Tacksharp AI Agents', visionops: 'Tacksharp VisionOps' };
export const PRODUCT_TAGLINE: Record<ProductFamily, string> = { agents: 'AI employees platform', visionops: 'Centralized CCTV monitoring' };
export const productOf = (industry: string | null | undefined): ProductFamily => (industry === 'cctv' ? 'visionops' : 'agents');

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
        { href: '/contacts', label: 'Customers', icon: Users },
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
    id: 'restaurant', label: 'GR Chicken Restaurant', short: 'GR Chicken', tagline: 'GR Chicken: WhatsApp and phone ordering by the kg, live orders, follow-ups and feedback.', icon: UtensilsCrossed,
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
      { section: 'Setup', items: [{ href: '/integrations', label: 'Settings & integrations', icon: PlugZap }, { href: '/settings', label: 'Business settings', icon: Settings }, ...WORKSPACE_TOOLS] },
    ],
    terms: { customer: 'customer', customers: 'customers', lead: 'customer', leads: 'customers', order: 'order', orders: 'orders', product: 'menu item', products: 'menu items' },
    settings: ['restaurant'],
    search: { placeholder: 'Search orders…', href: '/orders' },
  },
  food: {
    id: 'food', label: 'Restaurant & Food Ordering', short: 'Restaurant', tagline: 'Menu, WhatsApp and phone orders, pickup and delivery, kitchen status and feedback.', icon: ConciergeBell,
    accent: '#c2410c', accentSoft: '#fff1e6', onDark: '#fdba74',
    nav: [
      { section: 'Main', items: [
        { href: '/', label: 'Restaurant overview', icon: LayoutDashboard },
        { href: '/food/orders', label: 'Orders & kitchen', icon: ShoppingBag },
        { href: '/conversations', label: 'WhatsApp conversations', icon: MessageSquare },
        { href: '/contacts', label: 'Customers', icon: Users },
        { href: '/leads', label: 'Enquiries', icon: Columns3 },
      ] },
      { section: 'Menu', items: [
        { href: '/food/menu', label: 'Menu & availability', icon: UtensilsCrossed },
        { href: '/follow-ups', label: 'Follow-ups & feedback', icon: ListChecks },
        { href: '/handoffs', label: 'Complaints & handoffs', icon: Headset, badge: 'handoff' },
      ] },
      { section: 'AI & reports', items: [{ href: '/agents', label: 'AI agents', icon: Bot }, { href: '/analytics', label: 'Sales & analytics', icon: BarChart3 }] },
      SETUP,
    ],
    terms: { customer: 'customer', customers: 'customers', lead: 'customer', leads: 'customers', order: 'order', orders: 'orders', product: 'menu item', products: 'menu items' },
    settings: ['industry', 'food', 'team'],
    search: { placeholder: 'Search orders…', href: '/food/orders' },
  },
  hotel: {
    id: 'hotel', label: 'Hotel & Room Booking', short: 'Hotel', tagline: 'Room availability, rates, bookings, front desk and guest follow-ups.', icon: BedDouble,
    accent: '#0e7490', accentSoft: '#e4f5f8', onDark: '#67e8f9',
    nav: [
      { section: 'Front desk', items: [
        { href: '/', label: 'Hotel overview', icon: LayoutDashboard },
        { href: '/hotel/reservations', label: 'Reservations', icon: CalendarCheck },
        { href: '/hotel/availability', label: 'Availability calendar', icon: CalendarDays },
        { href: '/hotel/rooms', label: 'Rooms & rates', icon: DoorOpen },
      ] },
      { section: 'Guests', items: [
        { href: '/contacts', label: 'Guests', icon: Users },
        { href: '/conversations', label: 'Guest conversations', icon: MessageSquare },
        { href: '/leads', label: 'Booking enquiries', icon: Columns3 },
        { href: '/follow-ups', label: 'Guest follow-ups', icon: ListChecks },
        { href: '/handoffs', label: 'Guest service', icon: Headset, badge: 'handoff' },
      ] },
      { section: 'AI & reports', items: [{ href: '/agents', label: 'AI agents', icon: Bot }, { href: '/analytics', label: 'Occupancy & revenue', icon: BarChart3 }] },
      SETUP,
    ],
    terms: { customer: 'guest', customers: 'guests', lead: 'enquiry', leads: 'enquiries', order: 'reservation', orders: 'reservations', product: 'room', products: 'rooms' },
    settings: ['industry', 'hotel', 'team'],
    search: { placeholder: 'Search reservations…', href: '/hotel/reservations' },
  },
  hospital: {
    id: 'hospital', label: 'Hospital & Healthcare', short: 'Hospital', tagline: 'Appointments on real OPD slots, campaign leads, reminders and insurance paperwork.', icon: HeartPulse,
    accent: '#be123c', accentSoft: '#fdecef', onDark: '#fda4af',
    nav: [
      { section: 'Clinic', items: [
        { href: '/', label: 'Hospital overview', icon: LayoutDashboard },
        { href: '/hospital/appointments', label: 'Appointments', icon: CalendarCheck },
        { href: '/hospital/doctors', label: 'Doctors & OPD hours', icon: Stethoscope },
        { href: '/hospital/patients', label: 'Patients', icon: UserRound },
      ] },
      { section: 'Patient care', items: [
        { href: '/contacts', label: 'Patient contacts', icon: Users },
        { href: '/hospital/insurance', label: 'Insurance & claims', icon: ShieldCheck },
        { href: '/conversations', label: 'Patient conversations', icon: MessageSquare },
        { href: '/leads', label: 'Campaign leads', icon: Columns3 },
        { href: '/follow-ups', label: 'Reminders & follow-ups', icon: ListChecks },
        { href: '/handoffs', label: 'Escalations', icon: Headset, badge: 'handoff' },
      ] },
      { section: 'AI & reports', items: [{ href: '/agents', label: 'AI agents', icon: Bot }, { href: '/analytics', label: 'Hospital analytics', icon: BarChart3 }] },
      SETUP,
    ],
    terms: { customer: 'patient', customers: 'patients', lead: 'lead', leads: 'leads', order: 'appointment', orders: 'appointments', product: 'service', products: 'services' },
    settings: ['industry', 'hospital', 'team'],
    search: { placeholder: 'Search appointments…', href: '/hospital/appointments' },
  },
  cctv: {
    id: 'cctv', label: 'CCTV Monitoring (VisionOps)', short: 'VisionOps', tagline: 'Centralized CCTV monitoring: manage all sites from one screen.', icon: Cctv,
    accent: '#1e5bd8', accentSoft: '#e8effd', onDark: '#8fb0ff',
    nav: [
      { section: 'Monitoring', items: [
        { href: '/', label: 'Operations center', icon: LayoutDashboard },
        { href: '/visionops/incidents', label: 'Incidents', icon: Siren },
        { href: '/visionops/sites', label: 'Sites', icon: MapPin },
        { href: '/visionops/cameras', label: 'Cameras & recorders', icon: Cctv },
      ] },
      { section: 'Service', items: [
        { href: '/visionops/team', label: 'Technicians & agents', icon: UserCog },
        { href: '/visionops/notifications', label: 'WhatsApp alerts', icon: BellRing },
        { href: '/visionops/reports', label: 'Uptime & SLA reports', icon: FileBarChart },
        { href: '/visionops/plans', label: 'Plans & cost', icon: Calculator },
      ] },
      { section: 'AI', items: [{ href: '/agents', label: 'AI agents', icon: Bot }] },
      SETUP,
    ],
    terms: { customer: 'customer', customers: 'customers', lead: 'enquiry', leads: 'enquiries', order: 'incident', orders: 'incidents', product: 'camera', products: 'cameras' },
    settings: ['industry', 'monitoring'],
    search: { placeholder: 'Search cameras…', href: '/visionops/cameras' },
  },
  real_estate: {
    id: 'real_estate', label: 'Real Estate', short: 'Real estate', tagline: 'Lead qualification, AI calls and site visits.', icon: Building2,
    accent: '#0f9f6e', accentSoft: '#e7f7f0', onDark: '#34d399',
    nav: [
      { section: 'Main', items: [
        { href: '/', label: 'Real estate overview', icon: LayoutDashboard },
        { href: '/leads', label: 'Leads & CRM', icon: Columns3 },
        { href: '/contacts', label: 'Buyers & contacts', icon: Users },
        { href: '/conversations', label: 'WhatsApp conversations', icon: MessageSquare },
        { href: '/calls', label: 'AI voice calls', icon: Phone, badge: 'live' },
        { href: '/properties', label: 'Properties', icon: Building2 },
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
        { href: '/contacts', label: 'Customers', icon: Users },
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
      { section: 'Customers', items: [{ href: '/contacts', label: 'Customer contacts', icon: Users }, { href: '/conversations', label: 'Customer complaints', icon: MessageSquare }, { href: '/handoffs', label: 'Escalations', icon: Headset, badge: 'handoff' }] },
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
        { href: '/contacts', label: 'Clients & contacts', icon: Users },
        { href: '/conversations', label: 'Customer engagement', icon: MessageSquare },
        { href: '/follow-ups', label: 'Follow-up automation', icon: ListChecks },
        { href: '/handoffs', label: 'Team handoffs', icon: Headset, badge: 'handoff' },
      ] },
      { section: 'Campaigns', items: [
        { href: '/marketing', label: 'Campaign management', icon: Megaphone },
        { href: '/marketing?tab=audience', label: 'Audience & segments', icon: Users },
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

/**
 * One sidebar structure for every industry: Home, AI Agents, Customers & Leads, Conversations, Orders & Business
 * Activity, Analytics, Integrations, Settings. Each industry keeps its own items and labels (its registry above); this
 * only places them in the standard sections, in a fixed order, so every business finds things in the same place.
 */
export const STANDARD_SECTIONS = ['Home', 'AI Agents', 'Customers & Leads', 'Conversations', 'Orders & Business Activity', 'Analytics', 'Integrations', 'Settings'] as const;
export function sectionOf(href: string): (typeof STANDARD_SECTIONS)[number] {
  const p = href.split('?')[0];
  if (p === '/') return 'Home';
  if (/^\/(agents|voice-agents|test-chat)(\/|$)/.test(p)) return 'AI Agents';
  if (/^\/(contacts|customers|leads|follow-ups|site-visits|hospital\/patients)(\/|$)/.test(p)) return 'Customers & Leads';
  if (/^\/(conversations|calls|handoffs|activity|feedback)(\/|$)/.test(p) || p === '/visionops/notifications') return 'Conversations';
  if (/^\/(analytics|performance)(\/|$)/.test(p) || p === '/visionops/reports') return 'Analytics';
  if (/^\/(settings\/integrations|settings\/ai-providers|integrations)(\/|$)/.test(p)) return 'Integrations';
  if (/^\/(settings|team|demo-data|scenarios)(\/|$)/.test(p)) return 'Settings';
  return 'Orders & Business Activity';
}
export function standardNav(groups: NavGroup[]): NavGroup[] {
  const items = groups.flatMap((g) => g.items);
  const seen = new Set<string>();
  return STANDARD_SECTIONS.map((section) => ({
    section,
    items: items
      .filter((i) => sectionOf(i.href) === section && !seen.has(i.href) && seen.add(i.href))
      .map((i) => (i.href === '/' ? { ...i, label: 'Home' } : i)),
  })).filter((g) => g.items.length > 0);
}

import { Building2, Cctv, Drumstick, Factory, GraduationCap, HeartPulse, Hotel, Briefcase, ShoppingBag, Shirt, UtensilsCrossed, type LucideIcon } from 'lucide-react';

/**
 * What a business owner picks when signing up or setting up: plain categories with a short description. `value` is
 * what the server accepts (signup industry / Settings industry). `chicken_shop` sets the workspace up on the GR Chicken
 * ordering engine (menu by the kg, cuts, shops, pickup orders). A choice with `unavailable` is shown, labelled, and
 * cannot be selected: nothing is implied to work that does not.
 */
export type IndustryChoice = {
  value: string;
  title: string;
  description: string;
  icon: LucideIcon;
  /** The workspace industry this choice opens (web industry registry id). */
  opens?: string;
  unavailable?: string;
  note?: string;
};
export type IndustryCategory = { category: string; choices: IndustryChoice[] };

export const INDUSTRY_CATEGORIES: IndustryCategory[] = [
  {
    category: 'Restaurants & Food Service',
    choices: [
      { value: 'chicken_shop', opens: 'restaurant', title: 'GR Chicken / Chicken Shop', icon: Drumstick, description: 'AI-powered customer ordering, menu enquiries, order updates, and customer follow-ups for chicken shops.' },
      { value: 'food', opens: 'food', title: 'Restaurant & food ordering', icon: UtensilsCrossed, description: 'Menu questions, WhatsApp orders, pickup and delivery, kitchen status and feedback.' },
    ],
  },
  {
    category: 'Retail & E-commerce',
    choices: [
      { value: 'retail', opens: 'retail', title: 'Retail & e-commerce', icon: ShoppingBag, description: 'Customer enquiries, sales follow-up, campaigns and stock alerts.' },
      { value: 'textile', opens: 'textile', title: 'Textile & apparel', icon: Shirt, description: 'Catalogue questions, bulk enquiries, quotations and orders.' },
    ],
  },
  { category: 'Real Estate', choices: [{ value: 'real_estate', opens: 'real_estate', title: 'Real estate', icon: Building2, description: 'Lead follow-up by WhatsApp and phone, site visits and your sales pipeline.' }] },
  {
    category: 'Healthcare',
    choices: [{ value: 'hospital', opens: 'hospital', title: 'Hospital & clinic', icon: HeartPulse, description: 'Appointments and patient enquiries. No medical advice is given; patient details are visible only to authorised staff.' }],
  },
  { category: 'Hospitality', choices: [{ value: 'hotel', opens: 'hotel', title: 'Hotel & room booking', icon: Hotel, description: 'Room enquiries, reservations and guest messages.' }] },
  { category: 'Education', choices: [{ value: 'education', title: 'Schools & coaching', icon: GraduationCap, description: 'Admission enquiries and demo-class booking.', unavailable: 'Not available as its own setup yet. Choose "Professional services & other businesses" to start; the Education voice agent template works there.' }] },
  { category: 'Manufacturing', choices: [{ value: 'manufacturing', opens: 'manufacturing', title: 'Manufacturing & B2B', icon: Factory, description: 'Enquiries, quality inspections, stock and corrective actions.' }] },
  {
    category: 'Professional Services & Other Businesses',
    choices: [
      { value: 'agency', opens: 'agency', title: 'Professional services & other businesses', icon: Briefcase, description: 'Agencies, consultants and any other business: leads, follow-ups and custom AI agents.' },
      { value: 'cctv', opens: 'cctv', title: 'Security & CCTV monitoring', icon: Cctv, description: 'Sites, cameras, recorders, incidents and technicians.' },
    ],
  },
];

export const ALL_CHOICES = INDUSTRY_CATEGORIES.flatMap((c) => c.choices);

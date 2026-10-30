import { BadRequestException } from '@nestjs/common';

/**
 * Public self-service signup: input validation (pure, unit-tested). The service creates the organization, its
 * settings and its first admin in ONE transaction; nothing here touches the database.
 *
 * Industries offered at signup: everything an organization's Settings can choose. `restaurant` is the GR Chicken
 * engine (bound to that organization), so new restaurants get the general food-ordering module (`food`).
 */
/**
 * chicken_shop = "GR Chicken / Chicken Shop": the organization runs the meat-shop ordering engine (vertical
 * "restaurant": menu by the kg, cuts, outlets, pickup orders, ready calls). Everything else is a Settings industry.
 */
export const SIGNUP_INDUSTRIES = ['real_estate', 'food', 'chicken_shop', 'retail', 'manufacturing', 'hospital', 'cctv', 'textile', 'hotel', 'agency'] as const;
export type SignupIndustry = (typeof SIGNUP_INDUSTRIES)[number];

export type SignupInput = {
  organizationName: string;
  adminName: string;
  email: string;
  password: string;
  industry: SignupIndustry;
  phone: string | null;
};

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[A-Za-z]{2,24}$/;
/** Free-mail domains are allowed (small businesses use them) - this list only blocks throwaway inboxes. */
const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'yopmail.com', 'trashmail.com', 'sharklasers.com', 'getnada.com', 'dispostable.com']);

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max + 1) : '');

/** Password rules shared with invitation acceptance: 12+ characters, not the email, not one repeated character. */
export function passwordProblem(password: string, email?: string): string | null {
  if (password.length < 12) return 'Use at least 12 characters for the password.';
  if (password.length > 200) return 'That password is too long.';
  if (/^(.)\1+$/.test(password)) return 'Choose a password that is not one repeated character.';
  if (email && password.trim().toLowerCase() === email.trim().toLowerCase()) return 'The password must not be your email address.';
  return null;
}

/** Throws 400 with a `fields` map naming each problem (never echoes the password). */
export function validateSignup(body: Record<string, unknown> | null | undefined): SignupInput {
  const b = body ?? {};
  const errors: Record<string, string> = {};
  // Honeypot: a field real people never see. Bots that fill every input are refused with a generic message.
  if (clean(b.website, 200)) throw new BadRequestException('The registration could not be accepted.');

  const organizationName = clean(b.organizationName, 80);
  if (organizationName.length < 2) errors.organizationName = 'Enter your organization name.';
  else if (organizationName.length > 80) errors.organizationName = 'Keep the organization name under 80 characters.';
  else if (!/[\p{L}\p{N}]/u.test(organizationName)) errors.organizationName = 'The organization name needs letters or numbers.';

  const adminName = clean(b.adminName, 80);
  if (adminName.length < 2) errors.adminName = 'Enter your name.';
  else if (adminName.length > 80) errors.adminName = 'Keep your name under 80 characters.';

  const email = clean(b.email, 254).toLowerCase();
  if (!EMAIL.test(email)) errors.email = 'Enter a valid business email address.';
  else if (DISPOSABLE.has(email.split('@')[1])) errors.email = 'Use a permanent business email address.';

  const password = typeof b.password === 'string' ? b.password : '';
  const pw = passwordProblem(password, email);
  if (pw) errors.password = pw;

  const industry = clean(b.industry, 40) as SignupIndustry;
  if (!(SIGNUP_INDUSTRIES as readonly string[]).includes(industry)) errors.industry = 'Choose your industry.';

  let phone: string | null = null;
  const rawPhone = clean(b.phone, 30);
  if (rawPhone) {
    const digits = rawPhone.replace(/[\s()+-]/g, '');
    if (!/^\d{8,15}$/.test(digits)) errors.phone = 'Enter the phone number with country code, digits only (8 to 15).';
    else phone = digits;
  }
  if (b.acceptTerms !== true) errors.acceptTerms = 'Accept the terms of service and privacy policy to continue.';

  if (Object.keys(errors).length) throw new BadRequestException({ statusCode: 400, message: 'Please correct the highlighted fields.', fields: errors });
  return { organizationName, adminName, email, password, industry, phone };
}

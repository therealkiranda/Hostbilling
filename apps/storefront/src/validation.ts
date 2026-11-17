export interface OrderFormValues {
  name: string;
  email: string;
  phone: string;
  companyName: string;
  domain: string;
}

export type OrderField = keyof OrderFormValues;
export type OrderErrors = Partial<Record<OrderField, string>>;

export const FIELD_ORDER: OrderField[] = ['name', 'email', 'phone', 'companyName', 'domain'];

export const FIELD_MESSAGES = {
  name: 'Enter your full name.',
  email: 'Enter a valid email address, like name@example.com.',
  phone: 'Enter a phone number using digits, like +977 9812345678.',
  companyName: 'Company name is too long.',
  domain: 'Enter a domain like mystore.com, without http:// or a page address.',
} satisfies Record<OrderField, string>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9][0-9\s\-()]{5,19}$/;
const DOMAIN =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** Cleans up a pasted address: drops the scheme, any page path, and a trailing dot. */
export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '');
}

export function validateOrder(values: OrderFormValues): OrderErrors {
  const errors: OrderErrors = {};

  if (values.name.trim().length === 0 || values.name.trim().length > 120) {
    errors.name = FIELD_MESSAGES.name;
  }

  if (values.email.trim().length > 254 || !EMAIL.test(values.email.trim())) {
    errors.email = FIELD_MESSAGES.email;
  }

  if (values.phone.trim() && !PHONE.test(values.phone.trim())) {
    errors.phone = FIELD_MESSAGES.phone;
  }

  if (values.companyName.trim().length > 120) {
    errors.companyName = FIELD_MESSAGES.companyName;
  }

  if (!DOMAIN.test(normalizeDomain(values.domain))) {
    errors.domain = FIELD_MESSAGES.domain;
  }

  return errors;
}

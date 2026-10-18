/**
 * Basic checks for the checkout form, as pure functions: each returns an error message, or null when the value is
 * fine. The shop shows the message under the field. (Synthetic store: nothing is charged, but a form that accepts
 * "abc" as a phone number or a 1-digit CVV is not one a shopper could trust.)
 */

export type CheckoutField = 'name' | 'email' | 'phone' | 'address' | 'card' | 'exp' | 'cvv';

const digitsOf = (s: string) => s.replace(/\D/g, '');

export function checkName(v: string): string | null {
  const s = v.trim();
  if (!s) return 'Enter your full name.';
  if (!/^[\p{L}][\p{L}\s.'-]{1,59}$/u.test(s)) return 'Use letters only, for example Asha Rao.';
  return null;
}

export function checkEmail(v: string): string | null {
  const s = v.trim();
  if (!s) return 'Enter your email.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return 'Enter a valid email, for example name@example.com.';
  return null;
}

/** An Indian mobile number: 10 digits starting 6 to 9, with an optional +91 or 0. Spaces and dashes are fine, letters are not. */
export function checkPhone(v: string): string | null {
  const s = v.trim();
  if (!s) return 'Enter your phone number.';
  if (!/^[+\d\s()-]+$/.test(s)) return 'Phone numbers have digits only.';
  let d = digitsOf(s);
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d)) return 'Enter a 10-digit mobile number.';
  return null;
}

export function checkAddress(v: string): string | null {
  const s = v.trim();
  if (!s) return 'Enter your delivery address.';
  if (s.length < 8) return 'Add a little more: house or flat number and street.';
  return null;
}

/** The Luhn check every real card number passes (it catches a mistyped digit). */
export function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

export function checkCard(v: string): string | null {
  if (!v.trim()) return 'Enter your card number.';
  if (!/^[\d\s-]+$/.test(v.trim())) return 'Card numbers have digits only.';
  const d = digitsOf(v);
  if (d.length < 13 || d.length > 19) return 'A card number has 13 to 19 digits.';
  if (!luhn(d)) return 'That card number does not look right. Check each digit.';
  return null;
}

/** MM/YY, a real month, not already past. `now` is injectable for tests. */
export function checkExpiry(v: string, now: Date = new Date()): string | null {
  const s = v.trim();
  if (!s) return 'Enter the expiry as MM/YY.';
  const m = /^(\d{2})\s*\/\s*(\d{2})$/.exec(s);
  if (!m) return 'Use the format MM/YY, for example 08/29.';
  const month = Number(m[1]);
  const year = 2000 + Number(m[2]);
  if (month < 1 || month > 12) return 'The month must be 01 to 12.';
  // A card works through the last day of its expiry month.
  if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) return 'This card has expired.';
  if (year > now.getFullYear() + 20) return 'That expiry is too far away. Check the year.';
  return null;
}

/** 3 digits (4 on some cards). Digits only. */
export function checkCvv(v: string): string | null {
  const s = v.trim();
  if (!s) return 'Enter the 3 or 4 digit security code (CVV).';
  if (!/^\d{3,4}$/.test(s)) return 'The CVV is 3 or 4 digits, numbers only.';
  return null;
}

export const CHECKERS: Record<CheckoutField, (v: string) => string | null> = {
  name: checkName,
  email: checkEmail,
  phone: checkPhone,
  address: checkAddress,
  card: checkCard,
  exp: (v) => checkExpiry(v),
  cvv: checkCvv,
};

export const FIELD_ORDER: readonly CheckoutField[] = ['name', 'email', 'phone', 'address', 'card', 'exp', 'cvv'];

/** What the field shows as the shopper types: the card in groups of four, the expiry with its slash, numbers only where numbers belong. */
export function formatAsTyped(field: CheckoutField, value: string): string {
  switch (field) {
    case 'card':
      return digitsOf(value).slice(0, 19).replace(/(.{4})(?=.)/g, '$1 ');
    case 'cvv':
      return digitsOf(value).slice(0, 4);
    case 'exp': {
      const d = digitsOf(value).slice(0, 4);
      if (d.length > 2) return `${d.slice(0, 2)}/${d.slice(2)}`;
      return d.length === 2 && value.includes('/') ? `${d}/` : d;
    }
    case 'phone':
      return value.replace(/[^\d+\s()-]/g, '').slice(0, 18);
    default:
      return value;
  }
}

/** Every field with a problem, in form order, with its message; empty when the whole form is fine. */
export function problems(values: Partial<Record<CheckoutField, string>>): { field: CheckoutField; message: string }[] {
  return FIELD_ORDER.flatMap((field) => {
    const message = CHECKERS[field](values[field] ?? '');
    return message ? [{ field, message }] : [];
  });
}

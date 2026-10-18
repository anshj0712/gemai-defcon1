import { describe, expect, it } from 'vitest';
import { checkAddress, checkCard, checkCvv, checkEmail, checkExpiry, checkName, checkPhone, formatAsTyped, luhn, problems } from '../src/validation';

/** The checkout form's basic checks. Test card numbers only. */

describe('phone', () => {
  it('takes Indian mobile numbers in the usual shapes', () => {
    for (const ok of ['9876543210', '+91 98765 43210', '098765 43210', '(+91) 98765-43210']) expect(checkPhone(ok)).toBeNull();
  });
  it('rejects letters, short numbers and numbers that cannot be mobiles', () => {
    expect(checkPhone('98abc43210')).toMatch(/digits only/);
    expect(checkPhone('12345')).toMatch(/10-digit/);
    expect(checkPhone('1234567890')).toMatch(/10-digit/);
    expect(checkPhone('')).toMatch(/Enter/);
  });
});

describe('cvv', () => {
  it('is 3 or 4 digits', () => {
    expect(checkCvv('123')).toBeNull();
    expect(checkCvv('1234')).toBeNull();
    expect(checkCvv('12')).not.toBeNull();
    expect(checkCvv('12345')).not.toBeNull();
    expect(checkCvv('12a')).not.toBeNull();
    expect(checkCvv('')).not.toBeNull();
  });
});

describe('card', () => {
  it('passes the published test numbers and fails a mistyped digit', () => {
    expect(luhn('4111111111111111')).toBe(true);
    expect(checkCard('4111 1111 1111 1111')).toBeNull();
    expect(checkCard('4242-4242-4242-4242')).toBeNull();
    expect(checkCard('4111 1111 1111 1112')).toMatch(/does not look right/);
  });
  it('rejects letters and wrong lengths', () => {
    expect(checkCard('4111 abcd 1111 1111')).toMatch(/digits only/);
    expect(checkCard('4111 1111')).toMatch(/13 to 19/);
  });
});

describe('expiry', () => {
  const now = new Date('2026-10-18T00:00:00Z');
  it('accepts this month and later, MM/YY', () => {
    expect(checkExpiry('10/26', now)).toBeNull();
    expect(checkExpiry('12/30', now)).toBeNull();
  });
  it('rejects the past, bad months, bad shapes and absurd years', () => {
    expect(checkExpiry('09/26', now)).toMatch(/expired/);
    expect(checkExpiry('13/28', now)).toMatch(/01 to 12/);
    expect(checkExpiry('1228', now)).toMatch(/MM\/YY/);
    expect(checkExpiry('12/99', now)).toMatch(/too far/);
  });
});

describe('name, email, address', () => {
  it('want sensible values', () => {
    expect(checkName('Asha Rao')).toBeNull();
    expect(checkName("Ananya O'Neil-Rao")).toBeNull();
    expect(checkName('R2D2')).not.toBeNull();
    expect(checkName(' ')).not.toBeNull();
    expect(checkEmail('asha.rao@example.com')).toBeNull();
    expect(checkEmail('asha@')).not.toBeNull();
    expect(checkEmail('no at sign.com')).not.toBeNull();
    expect(checkAddress('12 MG Road, Bengaluru')).toBeNull();
    expect(checkAddress('abc')).not.toBeNull();
  });
});

describe('formatting as typed', () => {
  it('groups the card, adds the expiry slash, and keeps numbers numeric', () => {
    expect(formatAsTyped('card', '41111111')).toBe('4111 1111');
    expect(formatAsTyped('card', '4111 1111 1111 1111 99')).toBe('4111 1111 1111 1111 99');
    expect(formatAsTyped('cvv', '12a3456')).toBe('1234');
    expect(formatAsTyped('exp', '123')).toBe('12/3');
    expect(formatAsTyped('exp', '12/')).toBe('12/');
    expect(formatAsTyped('exp', '12')).toBe('12');
    expect(formatAsTyped('phone', '98ab76-54')).toBe('9876-54');
  });
  it('lets the simulator type a card and expiry one character at a time', () => {
    let card = '';
    for (const ch of '4111 1111 1111 1111') card = formatAsTyped('card', card + ch);
    expect(card).toBe('4111 1111 1111 1111');
    let exp = '';
    for (const ch of '12/30') exp = formatAsTyped('exp', exp + ch);
    expect(exp).toBe('12/30');
  });
});

describe('whole form', () => {
  it('lists every problem in form order, and nothing when all is well', () => {
    expect(problems({ name: 'Asha Rao', email: 'a@b.co', phone: '9876543210', address: '12 MG Road', card: '4111 1111 1111 1111', exp: '12/30', cvv: '123' })).toEqual([]);
    expect(problems({ name: 'Asha Rao', email: 'bad', phone: 'x', address: '12 MG Road', card: '4111 1111 1111 1111', exp: '12/30', cvv: '1' }).map((p) => p.field)).toEqual(['email', 'phone', 'cvv']);
  });
});

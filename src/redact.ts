/** Mask phone numbers, SIP addresses and emails so they can be shown to a model without exposing the full value. */
export function maskAddress(value: string | undefined): string | undefined {
  if (!value) return value;
  const raw = value.replace(/^(tel:|sip:)/i, '');
  const email = /^([^@\s]+)@(.+)$/.exec(raw);
  if (email) {
    const [, user, domain] = email;
    // SIP URIs with a phone number as user part
    if (/^\+?\d{6,}$/.test(user!)) return `${maskDigits(user!)}@${domain}`;
    return `${user![0]}•••@${domain}`;
  }
  if (/^[+\d\s().-]+$/.test(raw) && raw.replace(/\D/g, '').length >= 5) return maskDigits(raw);
  return value;
}

function maskDigits(s: string): string {
  const digits = s.replace(/\D/g, '');
  const keep = digits.slice(-4);
  const prefix = s.startsWith('+') ? `+${digits.slice(0, digits.length > 10 ? digits.length - 10 : 1)}` : '';
  return `${prefix}•••${keep}`;
}

/** Customer names are reduced to initials. */
export function maskName(name: string | undefined): string | undefined {
  if (!name) return name;
  if (/^\+?[\d\s()-]{6,}$/.test(name)) return maskAddress(name);
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `${w[0]!.toUpperCase()}.`)
    .join(' ');
}

/** Mask email addresses and phone numbers that appear inside free text, such as survey comments. */
export function maskText(text: string | undefined): string | undefined {
  if (!text) return text;
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, (m) => maskAddress(m) ?? m)
    .replace(/\+?\d[\d\s().-]{5,}\d/g, (m) => (m.replace(/\D/g, '').length >= 7 && !/^\d{4}-\d{2}-\d{2}$/.test(m) ? (maskAddress(m) ?? m) : m));
}

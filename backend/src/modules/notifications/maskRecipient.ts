/**
 * NotificationLog is an operational audit trail that support staff, and anyone with database
 * access, will read routinely. It does not need to hold a readable address to do its job: the
 * order is already linked, and the real address lives on the customer record behind RBAC.
 *
 * So the recipient is masked at the point of writing, not at the point of display. Masking on
 * display leaves the plaintext in the table, and the table is what ends up in a backup, a support
 * export, or a screenshot in a ticket.
 *
 * The mask is deliberately lossy and irreversible. Enough survives to recognise an address you
 * already know ("is that the gmail one?") and to spot an obviously wrong domain, which is what
 * support actually needs. It is not enough to contact the customer.
 */

/** `ravi.kumar@example.com` -> `ra***@example.com`; `+919876543210` -> `+91******3210`. */
export function maskRecipient(recipient: string): string {
  const value = recipient.trim();
  if (value === '') return '';

  const at = value.lastIndexOf('@');
  if (at > 0) {
    const local = value.slice(0, at);
    const domain = value.slice(at);
    // Domain is kept: it is not personal data and a wrong one is the common support question.
    return `${local.slice(0, Math.min(2, local.length))}***${domain}`;
  }

  const digits = value.replace(/\D/g, '');
  if (digits.length >= 7) {
    const cc = value.startsWith('+') ? value.slice(0, value.length - digits.length + 2) : '';
    return `${cc}${'*'.repeat(Math.max(0, digits.length - (cc ? 2 : 0) - 4))}${digits.slice(-4)}`;
  }

  // Anything else (an in-app user id, a username) keeps only its first character.
  return `${value.slice(0, 1)}***`;
}

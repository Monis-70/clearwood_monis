import type { MailDriver } from './mail.driver';

/**
 * TODO (going live):
 * SMTP is deliberately NOT implemented yet — no mail credentials exist and this prompt must work
 * offline. `createMailer()` already refuses to select this driver unless every SMTP key is present.
 *
 * To enable later:
 *   1. `npm i nodemailer --workspace backend` (+ `@types/nodemailer`)
 *   2. Create one transport from SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS (secure when
 *      port 465) and map `MailMessage` onto `transport.sendMail`.
 *   3. Default `from` to MAIL_FROM and return the provider message id.
 *   4. Set MAIL_DRIVER=smtp — no other code changes.
 */
export function createSmtpMailDriver(): MailDriver {
  throw new Error(
    'MAIL_DRIVER=smtp is not implemented yet. Keep MAIL_DRIVER=log until the SMTP driver ships (see backend/src/drivers/mail/smtp.mail.ts).',
  );
}

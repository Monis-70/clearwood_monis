import type { OtpDriver } from './otp.driver';

/**
 * TODO (post-launch): SMS and WhatsApp are deliberately NOT implemented yet — no provider account
 * exists and this build must run offline. `createOtpSender()` already refuses to select either
 * driver unless SMS_API_KEY and SMS_SENDER_ID are present.
 *
 * To enable later:
 *   1. Pick a provider (MSG91 / Gupshup / Twilio) and add its SDK to the backend workspace.
 *   2. Implement `send()` against SMS_API_KEY + SMS_SENDER_ID; return the provider message id.
 *   3. For WHATSAPP, send the approved template rather than free text.
 *   4. Set OTP_DRIVER=sms (or whatsapp) — no other code changes.
 */
export function createSmsOtpDriver(channel: 'sms' | 'whatsapp'): OtpDriver {
  throw new Error(
    `OTP_DRIVER=${channel} is not implemented yet. Keep OTP_DRIVER=log until the provider driver ships (see backend/src/drivers/otp/sms.otp.ts).`,
  );
}

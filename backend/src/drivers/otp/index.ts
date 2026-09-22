import type { Env } from '../../config/env';
import { logger } from '../../config/logger';

import { LogOtpDriver } from './log.otp';
import type { OtpDriver } from './otp.driver';
import { createSmsOtpDriver } from './sms.otp';

export type { OtpDriver, OtpMessage, OtpSendResult } from './otp.driver';
export { LogOtpDriver } from './log.otp';

export function createOtpSender(env: Env): OtpDriver {
  switch (env.OTP_DRIVER) {
    case 'sms':
    case 'whatsapp':
      return createSmsOtpDriver(env.OTP_DRIVER);
    case 'log':
    default:
      logger.debug({ driver: 'log' }, 'otp driver ready');
      return new LogOtpDriver();
  }
}

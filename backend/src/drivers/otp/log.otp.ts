import { randomUUID } from 'node:crypto';

import { isProduction } from '../../config/env';
import { logger } from '../../config/logger';

import type { OtpDriver, OtpMessage, OtpSendResult } from './otp.driver';

/** Prints the message to the console. The code itself is logged in development ONLY. */
export class LogOtpDriver implements OtpDriver {
  readonly name = 'log' as const;

  async send(message: OtpMessage): Promise<OtpSendResult> {
    const id = randomUUID();

    logger.info(
      {
        id,
        channel: message.channel,
        destination: message.destination,
        ...(isProduction ? {} : { code: message.code }),
      },
      isProduction
        ? 'otp dispatched (log driver)'
        : `OTP for ${message.destination}: ${message.code}`,
    );

    return { id, channel: message.channel, driver: this.name };
  }
}

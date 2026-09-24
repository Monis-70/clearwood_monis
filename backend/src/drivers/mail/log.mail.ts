import { randomUUID } from 'node:crypto';

import { isProduction } from '../../config/env';
import { logger } from '../../config/logger';
import { maskRecipient } from '../../modules/notifications/maskRecipient';

import type { MailDriver, MailMessage, MailResult } from './mail.driver';

/**
 * Prints the message to the console instead of sending it. Used until SMTP credentials exist.
 *
 * The BODY is logged in development only. Mail carries bearer secrets - password-reset and invite
 * tokens - and production logs are read by far more people than an inbox, so there the log holds
 * who, what and how much, never the content. (The same rule `LogOtpDriver` applies to codes.)
 */
export class LogMailDriver implements MailDriver {
  readonly name = 'log' as const;

  constructor(private readonly defaultFrom: string) {}

  async send(message: MailMessage): Promise<MailResult> {
    const accepted = ([] as string[]).concat(message.to);
    const id = randomUUID();
    const body = message.text ?? message.html ?? '';

    logger.info(
      {
        mail: {
          id,
          from: message.from ?? this.defaultFrom,
          to: isProduction ? accepted.map(maskRecipient) : accepted,
          subject: message.subject,
          ...(isProduction ? { bodyLength: body.length } : { body }),
        },
      },
      isProduction
        ? 'mail accepted (log driver — not delivered; body withheld)'
        : 'mail sent (log driver — nothing left this machine)',
    );

    return { id, accepted, driver: this.name };
  }
}

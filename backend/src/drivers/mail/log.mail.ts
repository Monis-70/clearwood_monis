import { randomUUID } from 'node:crypto';

import { logger } from '../../config/logger';

import type { MailDriver, MailMessage, MailResult } from './mail.driver';

/** Prints the message to the console instead of sending it. Used until SMTP credentials exist. */
export class LogMailDriver implements MailDriver {
  readonly name = 'log' as const;

  constructor(private readonly defaultFrom: string) {}

  async send(message: MailMessage): Promise<MailResult> {
    const accepted = ([] as string[]).concat(message.to);
    const id = randomUUID();

    logger.info(
      {
        mail: {
          id,
          from: message.from ?? this.defaultFrom,
          to: accepted,
          subject: message.subject,
          body: message.text ?? message.html ?? '',
        },
      },
      'mail sent (log driver — nothing left this machine)',
    );

    return { id, accepted, driver: this.name };
  }
}

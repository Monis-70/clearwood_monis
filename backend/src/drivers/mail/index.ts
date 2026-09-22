import type { Env } from '../../config/env';
import { logger } from '../../config/logger';

import { LogMailDriver } from './log.mail';
import type { MailDriver } from './mail.driver';
import { createSmtpMailDriver } from './smtp.mail';

export type { MailDriver, MailMessage, MailResult } from './mail.driver';
export { LogMailDriver } from './log.mail';

export function createMailer(env: Env): MailDriver {
  switch (env.MAIL_DRIVER) {
    case 'smtp':
      return createSmtpMailDriver();
    case 'log':
    default:
      logger.debug({ driver: 'log', from: env.MAIL_FROM }, 'mail driver ready');
      return new LogMailDriver(env.MAIL_FROM);
  }
}

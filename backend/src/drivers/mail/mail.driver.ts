import type { MailDriver as MailDriverName } from '@shared/enums';

export interface MailMessage {
  to: string | string[];
  subject: string;
  /** At least one of `text` / `html` must be supplied. */
  text?: string;
  html?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  from?: string;
}

export interface MailResult {
  id: string;
  accepted: string[];
  driver: MailDriverName;
}

export interface MailDriver {
  readonly name: MailDriverName;
  send(message: MailMessage): Promise<MailResult>;
}

import type { OtpChannel, OtpDriver as OtpDriverName } from '@shared/enums';

export interface OtpMessage {
  channel: OtpChannel;
  destination: string;
  message: string;
  /** Only for the log driver's development output — never persisted, never sent to production logs. */
  code?: string;
}

export interface OtpSendResult {
  id: string;
  channel: OtpChannel;
  driver: OtpDriverName;
}

export interface OtpDriver {
  readonly name: OtpDriverName;
  send(message: OtpMessage): Promise<OtpSendResult>;
}

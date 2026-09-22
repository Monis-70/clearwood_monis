import type { Request, Response } from 'express';

import type { NotificationLogQuery, NotificationTemplateInput } from '@shared/schemas/fulfilment';

import { auditService } from '../modules/auth/audit.service';
import { tokensIn } from '../modules/notifications/templateRenderer';
import { notificationRepository } from '../repositories/document.repository';
import { ok, paginated } from '../utils/response';

/** R1 — thin: resolve the caller, call a repository or service, answer through the one envelope. */

function toTemplateDto(template: {
  id: string;
  event: string;
  channel: string;
  subject: string | null;
  body: string;
  isActive: boolean;
  version: number;
  updatedAt: Date;
}) {
  return {
    id: template.id,
    event: template.event,
    channel: template.channel,
    subject: template.subject,
    body: template.body,
    isActive: template.isActive,
    version: template.version,
    // The vocabulary an editor is allowed to use, so the console can show it beside the textarea.
    tokens: tokensIn(`${template.subject ?? ''}\n${template.body}`),
    updatedAt: template.updatedAt.toISOString(),
  };
}

function toLogDto(log: {
  id: string;
  event: string;
  channel: string;
  recipient: string;
  subject: string | null;
  status: string;
  error: string | null;
  orderId: string | null;
  sentAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: log.id,
    event: log.event,
    channel: log.channel,
    // Already masked when written. There is no unmasked copy to leak here.
    recipient: log.recipient,
    subject: log.subject,
    status: log.status,
    error: log.error,
    orderId: log.orderId,
    sentAt: log.sentAt?.toISOString() ?? null,
    createdAt: log.createdAt.toISOString(),
  };
}

export const adminNotificationController = {
  async listTemplates(_req: Request, res: Response): Promise<void> {
    const templates = await notificationRepository.listTemplates();
    ok(res, templates.map(toTemplateDto));
  },

  async upsertTemplate(req: Request, res: Response): Promise<void> {
    const input = req.body as NotificationTemplateInput;

    const template = await notificationRepository.upsertTemplate(input.event, input.channel, {
      subject: input.subject ?? null,
      body: input.body,
      isActive: input.isActive,
    });

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'NotificationTemplate',
      entityId: template.id,
      severity: 'NOTICE',
      meta: { event: input.event, channel: input.channel, version: template.version },
    });

    ok(res, toTemplateDto(template));
  },

  async listLogs(req: Request, res: Response): Promise<void> {
    const query = req.query as unknown as NotificationLogQuery;
    const page = await notificationRepository.listLogs(query);

    paginated(res, page.items.map(toLogDto), page);
  },
};

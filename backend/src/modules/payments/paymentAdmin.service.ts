import type { SplitAccount, SplitRule } from '@prisma/client';
import type { SplitBasis, SplitMode, SplitScope } from '@shared/enums';
import type {
  PaymentSettingsInput,
  SplitAccountCreateInput,
  SplitAccountUpdateInput,
  SplitRuleCreateInput,
  SplitRuleListQuery,
  SplitRuleUpdateInput,
} from '@shared/schemas/order';
import type { SplitAccountDto, SplitRuleDto } from '@shared/types/order';

import { codEnabled, env, splitEnabled } from '../../config/env';
import { prisma } from '../../config/prisma';
import { splitAccountRepository, splitRuleRepository, refundRepository } from '../../repositories/payment.repository';
import { AppError } from '../../utils/AppError';

import { splitService } from './split/split.service';

/**
 * Admin control over the payout side.
 *
 * Every number the split engine uses is DATA, not code: an admin changes who gets what without a
 * deploy. The guards here are the ones the engine relies on — one active REMAINDER rule, a
 * recipient that actually exists, and a value that matches the mode.
 */

export interface PaymentSettings {
  splitEnabled: boolean;
  codEnabled: boolean;
  codMaxOrderPaise: number;
  codFeePaise: number;
  methodsEnabled: string[];
  captureMode: 'AUTOMATIC' | 'MANUAL';
  holdMinutes: number;
  cancellationWindowHours: number;
  autoConfirmCod: boolean;
}

const SETTING_KEYS = {
  splitEnabled: { key: 'payment.split.enabled', type: 'boolean' as const },
  codEnabled: { key: 'payment.cod.enabled', type: 'boolean' as const },
  codMaxOrderPaise: { key: 'payment.cod.max_order_paise', type: 'number' as const },
  codFeePaise: { key: 'payment.cod.fee_paise', type: 'number' as const },
  methodsEnabled: { key: 'payment.methods_enabled', type: 'json' as const },
  captureMode: { key: 'payment.capture_mode', type: 'string' as const },
  holdMinutes: { key: 'payment.hold_minutes', type: 'number' as const },
  cancellationWindowHours: { key: 'order.cancellation_window_hours', type: 'number' as const },
  autoConfirmCod: { key: 'order.auto_confirm_cod', type: 'boolean' as const },
};

function toAccountDto(row: SplitAccount): SplitAccountDto {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    providerAccountId: row.providerAccountId,
    isActive: row.isActive,
    isPrimary: row.isPrimary,
    notes: row.notes,
    version: row.version,
  };
}

function toRuleDto(row: SplitRule): SplitRuleDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    scope: row.scope as SplitScope,
    scopeEntityId: row.scopeEntityId,
    basis: row.basis as SplitBasis,
    mode: row.mode as SplitMode,
    valuePaise: row.valuePaise,
    valueBp: row.valueBp,
    recipientKey: row.recipientKey,
    priority: row.priority,
    isActive: row.isActive,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    minOrderPaise: row.minOrderPaise,
    maxTransferPaise: row.maxTransferPaise,
    onHold: row.onHold,
    onHoldUntil: row.onHoldUntil?.toISOString() ?? null,
    notes: row.notes,
    version: row.version,
  };
}

export const paymentAdminService = {
  toAccountDto,
  toRuleDto,

  /* --------------------------------------------------------- accounts */

  async listAccounts(): Promise<SplitAccountDto[]> {
    return (await splitAccountRepository.list()).map(toAccountDto);
  },

  async createAccount(input: SplitAccountCreateInput): Promise<SplitAccountDto> {
    const existing = await splitAccountRepository.findByKey(input.key);
    if (existing) {
      throw AppError.conflict(`A split account with the key ${input.key} already exists`);
    }

    const created = await splitAccountRepository.create(input);
    if (input.isPrimary) await splitAccountRepository.setPrimary(created.id);

    return toAccountDto((await splitAccountRepository.findById(created.id))!);
  },

  async updateAccount(id: string, input: SplitAccountUpdateInput): Promise<SplitAccountDto> {
    const existing = await splitAccountRepository.findById(id);
    if (!existing) throw AppError.notFound('Split account not found', { id });

    if (input.version !== undefined && input.version !== existing.version) {
      throw new AppError(409, 'STALE_RESOURCE', 'Somebody else changed this account — reload', {
        expected: input.version,
        actual: existing.version,
      });
    }

    const { version: _version, isPrimary, ...rest } = input;
    const updated = await splitAccountRepository.update(id, rest);

    if (isPrimary) await splitAccountRepository.setPrimary(id);

    return toAccountDto((await splitAccountRepository.findById(updated.id))!);
  },

  /* ------------------------------------------------------------ rules */

  async listRules(query: SplitRuleListQuery) {
    const page = await splitRuleRepository.list(query);
    return { ...page, items: page.items.map(toRuleDto) };
  },

  async createRule(input: SplitRuleCreateInput): Promise<SplitRuleDto> {
    await this.assertRecipientExists(input.recipientKey);
    await splitService.assertSingleRemainder(input.mode, input.isActive);

    const existing = await splitRuleRepository.findByCode(input.code);
    if (existing)
      throw AppError.conflict(`A split rule with the code ${input.code} already exists`);

    return toRuleDto(
      await splitRuleRepository.create({
        ...input,
        valuePaise: input.valuePaise ?? null,
        valueBp: input.valueBp ?? null,
        scopeEntityId: input.scopeEntityId ?? null,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        minOrderPaise: input.minOrderPaise ?? null,
        maxTransferPaise: input.maxTransferPaise ?? null,
        onHoldUntil: input.onHoldUntil ?? null,
        notes: input.notes ?? null,
      }),
    );
  },

  async updateRule(id: string, input: SplitRuleUpdateInput): Promise<SplitRuleDto> {
    const existing = await splitRuleRepository.findById(id);
    if (!existing) throw AppError.notFound('Split rule not found', { id });

    if (input.version !== undefined && input.version !== existing.version) {
      throw new AppError(409, 'STALE_RESOURCE', 'Somebody else changed this rule — reload', {
        expected: input.version,
        actual: existing.version,
      });
    }

    if (input.recipientKey) await this.assertRecipientExists(input.recipientKey);

    const mode = input.mode ?? (existing.mode as SplitMode);
    const isActive = input.isActive ?? existing.isActive;
    await splitService.assertSingleRemainder(mode, isActive, id);

    const { version: _version, ...rest } = input;
    return toRuleDto(await splitRuleRepository.update(id, rest));
  },

  async removeRule(id: string): Promise<void> {
    const existing = await splitRuleRepository.findById(id);
    if (!existing) throw AppError.notFound('Split rule not found', { id });

    await splitRuleRepository.remove(id);
  },

  async assertRecipientExists(key: string): Promise<void> {
    const account = await splitAccountRepository.findByKey(key);
    if (!account) {
      throw AppError.validation(`There is no split account with the key ${key}`, { key });
    }
    if (!account.isActive) {
      throw AppError.validation(`The split account ${key} is inactive`, { key });
    }
  },

  /* --------------------------------------------------------- settings */

  /**
   * H6 - the needs-attention queue.
   *
   * PENDING_VERIFICATION is the important entry: it means a provider call may or may not have moved
   * a customer's money, and no sweep is allowed to guess. Everything here waits for a person.
   */
  async needsAttention() {
    const cutoff = new Date(Date.now() - env.REFUND_LOCK_TIMEOUT_MINUTES * 60_000);

    const [refunds, reversals] = await Promise.all([
      refundRepository.needsAttention(cutoff),
      prisma.transferReversal.findMany({
        where: { status: { in: ['PENDING_VERIFICATION', 'FAILED'] } },
        include: { refund: { select: { refundNumber: true } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    ]);

    const reason = (refund: (typeof refunds)[number]): string => {
      if (refund.status === 'PENDING_VERIFICATION') {
        return refund.capacityReserved
          ? 'The provider never confirmed this refund. Its capacity is still held, so the order cannot be fully refunded until it is verified.'
          : 'The provider never confirmed this refund. Verify it before doing anything else.';
      }
      if (refund.status === 'PROCESSING') {
        return 'Execution has been locked longer than the timeout — the worker probably died.';
      }
      return refund.errorDescription ?? 'The provider rejected this refund.';
    };

    return {
      refunds: refunds.map((refund) => ({
        id: refund.id,
        refundNumber: refund.refundNumber,
        orderNumber: refund.order.orderNumber,
        status: refund.status,
        amountPaise: refund.amountPaise,
        executionAttempt: refund.executionAttempt,
        executionLockedAt: refund.executionLockedAt,
        providerRefundId: refund.providerRefundId,
        // H7 - held capacity is why an order may refuse a further refund.
        capacityHeldPaise: refund.capacityReserved ? refund.amountPaise : 0,
        reason: reason(refund),
        // Only reconciliation may resolve a PENDING_VERIFICATION; the UI must not offer a retry.
        canRetry: refund.status === 'FAILED',
      })),
      reversals: reversals.map((reversal) => ({
        id: reversal.id,
        refundNumber: reversal.refund?.refundNumber ?? null,
        status: reversal.status,
        amountPaise: reversal.amountPaise,
        error: reversal.errorDescription,
        canRetry: reversal.status === 'FAILED',
      })),
      total: refunds.length + reversals.length,
    };
  },

  async readSettings(): Promise<PaymentSettings> {
    const rows = await prisma.appSetting.findMany({
      where: { key: { in: Object.values(SETTING_KEYS).map((entry) => entry.key) } },
    });
    const byKey = new Map(rows.map((row) => [row.key, row.value]));

    const bool = (key: string, fallback: boolean): boolean =>
      byKey.has(key) ? byKey.get(key) === 'true' : fallback;
    const num = (key: string, fallback: number): number =>
      byKey.has(key) ? Number(byKey.get(key)) : fallback;

    let methods: string[] = ['RAZORPAY', 'COD'];
    const rawMethods = byKey.get(SETTING_KEYS.methodsEnabled.key);
    if (rawMethods) {
      try {
        methods = JSON.parse(rawMethods) as string[];
      } catch {
        // A corrupt setting must not take checkout down; the default stands.
      }
    }

    return {
      splitEnabled: bool(SETTING_KEYS.splitEnabled.key, splitEnabled),
      codEnabled: bool(SETTING_KEYS.codEnabled.key, codEnabled),
      codMaxOrderPaise: num(SETTING_KEYS.codMaxOrderPaise.key, env.COD_MAX_ORDER_PAISE),
      codFeePaise: num(SETTING_KEYS.codFeePaise.key, env.COD_FEE_PAISE),
      methodsEnabled: methods,
      captureMode:
        (byKey.get(SETTING_KEYS.captureMode.key) as 'AUTOMATIC' | 'MANUAL') ?? 'AUTOMATIC',
      holdMinutes: num(SETTING_KEYS.holdMinutes.key, env.CHECKOUT_HOLD_MINUTES),
      cancellationWindowHours: num(SETTING_KEYS.cancellationWindowHours.key, 24),
      autoConfirmCod: bool(SETTING_KEYS.autoConfirmCod.key, true),
    };
  },

  async updateSettings(input: PaymentSettingsInput): Promise<PaymentSettings> {
    for (const [field, value] of Object.entries(input)) {
      if (value === undefined) continue;

      const mapping = SETTING_KEYS[field as keyof typeof SETTING_KEYS];
      if (!mapping) continue;

      const serialised = mapping.type === 'json' ? JSON.stringify(value) : String(value);

      await prisma.appSetting.upsert({
        where: { key: mapping.key },
        update: { value: serialised },
        create: {
          key: mapping.key,
          value: serialised,
          group: 'payment',
          valueType: mapping.type,
          isPublic: mapping.key === 'payment.cod.enabled',
        },
      });
    }

    return this.readSettings();
  },
};

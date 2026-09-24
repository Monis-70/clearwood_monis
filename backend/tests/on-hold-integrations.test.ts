import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { env, resolveOnlinePayments, resolveShippingDriver } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { MOCK_WEBHOOK_SECRET, MockPaymentDriver, createPayment } from '../src/drivers/payment';
import { providerGateway } from '../src/modules/fulfilment/providerGateway.service';

/**
 * Razorpay and Shiprocket are ON HOLD. Their drivers stay in the tree so enabling them later is a
 * configuration change - and these tests pin that neither can become active by accident, and that
 * a half-configured courier never takes the API down with it.
 *
 * Boot-time behaviour is checked in a child process, because the env module parses once per
 * process and its whole job at startup is its exit code and its output.
 */

const backendRoot = path.resolve(__dirname, '..');
const tsxCli = path.resolve(backendRoot, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

/** Loads config/env in a fresh process and prints what it resolved. */
function bootConfig(overrides: Record<string, string>): { status: number; output: string } {
  const probe =
    "import('./src/config/env').then((m) => console.log(JSON.stringify({ host: m.env.HOST, drivers: m.activeDrivers })))";

  try {
    const output = execFileSync(process.execPath, [tsxCli, '-e', probe], {
      cwd: backendRoot,
      // An empty value means "not provided" to config/env, and dotenv never overrides a key that
      // is already set, so these win over whatever the developer's backend/.env contains.
      env: { ...process.env, NODE_ENV: 'test', ...overrides },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

function resolved(output: string): { host: string; drivers: Record<string, string> } {
  const line = output
    .trim()
    .split(/\r?\n/)
    .find((entry) => entry.startsWith('{'));
  return JSON.parse(line ?? '{}');
}

const RAZORPAY_KEYS = {
  PAYMENT_DRIVER: 'razorpay',
  RAZORPAY_KEY_ID: 'key_id_for_a_config_test',
  RAZORPAY_KEY_SECRET: 'key_secret_for_a_config_test',
  RAZORPAY_WEBHOOK_SECRET: 'webhook_secret_for_a_config_test',
  RAZORPAY_ACCOUNT_PRIMARY: 'primary_account_for_a_config_test',
  RAZORPAY_ACCOUNT_SECONDARY: 'secondary_account_for_a_config_test',
};

describe('startup', () => {
  it('binds to loopback when HOST is not set', () => {
    const { status, output } = bootConfig({ HOST: '' });

    expect(status, output).toBe(0);
    expect(resolved(output).host).toBe('127.0.0.1');
  }, 60_000);

  it('passes HOST to listen, rather than binding every interface', () => {
    const server = readFileSync(path.join(backendRoot, 'src', 'server.ts'), 'utf8');

    expect(server).toMatch(/\.listen\(\s*env\.API_PORT,\s*env\.HOST,/);
  });
});

describe('Razorpay is on hold', () => {
  it('refuses to boot on PAYMENT_DRIVER=razorpay without RAZORPAY_ENABLED=true', () => {
    const refused = bootConfig({ ...RAZORPAY_KEYS, RAZORPAY_ENABLED: '' });

    expect(refused.status).not.toBe(0);
    expect(refused.output).toContain('RAZORPAY_ENABLED');
    // Key names only: a configuration error never echoes a secret.
    expect(refused.output).not.toContain(RAZORPAY_KEYS.RAZORPAY_KEY_SECRET);

    // G1: with the deliberate second switch, the very same configuration boots.
    const enabled = bootConfig({ ...RAZORPAY_KEYS, RAZORPAY_ENABLED: 'true' });
    expect(enabled.status, enabled.output).toBe(0);
    expect(resolved(enabled.output).drivers.payment).toBe('razorpay');
  }, 60_000);

  it('offers online payment in production only through a deliberately enabled provider', () => {
    const production = { NODE_ENV: 'production' as const, RAZORPAY_ENABLED: 'false' as const };

    expect(resolveOnlinePayments({ ...production, PAYMENT_DRIVER: 'mock' })).toBe(false);
    expect(
      resolveOnlinePayments({
        ...production,
        PAYMENT_DRIVER: 'razorpay',
        RAZORPAY_ENABLED: 'true',
      }),
    ).toBe(true);
    // Development and tests keep the full mock flow.
    expect(
      resolveOnlinePayments({
        NODE_ENV: 'development',
        PAYMENT_DRIVER: 'mock',
        RAZORPAY_ENABLED: 'false',
      }),
    ).toBe(true);
    expect(resolveOnlinePayments(env)).toBe(true);
  });

  it('refuses every mock signature in production, so a forged payment confirms nothing', async () => {
    const productionDriver = createPayment({ ...env, NODE_ENV: 'production' });
    const developmentDriver = new MockPaymentDriver();

    expect(productionDriver).toBeInstanceOf(MockPaymentDriver);

    for (const [driver, trusted] of [
      [productionDriver as MockPaymentDriver, false],
      [developmentDriver, true],
    ] as const) {
      const order = await driver.createOrder({
        amountPaise: 150_000,
        currency: 'INR',
        receipt: `CW-HOLD-${String(trusted)}`,
      });
      // Exactly what an attacker can compute: the mock's secrets are public constants.
      const forged = driver.simulateCheckout(order.providerOrderId);
      const body = Buffer.from(JSON.stringify({ id: 'evt_forged', event: 'payment.captured' }));
      const signature = createHmac('sha256', MOCK_WEBHOOK_SECRET).update(body).digest('hex');

      expect(driver.verifyPaymentSignature(forged)).toBe(trusted);
      expect(driver.verifyWebhookSignature(body, signature)).toBe(trusted);
    }
  });
});

describe('Shiprocket is on hold', () => {
  const unset = {
    SHIPROCKET_EMAIL: undefined,
    SHIPROCKET_PASSWORD: undefined,
    SHIPROCKET_WEBHOOK_TOKEN: undefined,
  };
  const credentials = {
    SHIPROCKET_EMAIL: 'api-user',
    SHIPROCKET_PASSWORD: 'api-password',
    SHIPROCKET_WEBHOOK_TOKEN: 'webhook-token',
  };
  const selected = {
    NODE_ENV: 'development' as const,
    SHIPPING_DRIVER: 'shiprocket' as const,
    SHIPROCKET_ENABLED: 'false' as const,
    SHIPPING_PROVIDER_VERIFIED: 'false' as const,
  };

  it('falls back to manual, and says why, instead of refusing to boot', () => {
    expect(resolveShippingDriver({ ...selected, ...unset })).toEqual({
      driver: 'manual',
      heldBack: expect.stringContaining('SHIPROCKET_ENABLED'),
    });
    expect(resolveShippingDriver({ ...selected, ...unset, SHIPROCKET_ENABLED: 'true' })).toEqual({
      driver: 'manual',
      heldBack: expect.stringContaining('SHIPROCKET_EMAIL'),
    });
    expect(
      resolveShippingDriver({
        ...selected,
        ...credentials,
        NODE_ENV: 'production',
        SHIPROCKET_ENABLED: 'true',
      }),
    ).toEqual({
      driver: 'manual',
      heldBack: expect.stringContaining('SHIPPING_PROVIDER_VERIFIED'),
    });

    // G1: fully enabled, configured and (in production) verified, it is selected.
    expect(
      resolveShippingDriver({
        ...selected,
        ...credentials,
        NODE_ENV: 'production',
        SHIPROCKET_ENABLED: 'true',
        SHIPPING_PROVIDER_VERIFIED: 'true',
      }),
    ).toEqual({ driver: 'shiprocket', heldBack: null });
  });

  it('boots with SHIPPING_DRIVER=shiprocket and nothing else, reporting manual', () => {
    const { status, output } = bootConfig({
      SHIPPING_DRIVER: 'shiprocket',
      SHIPROCKET_ENABLED: '',
      SHIPROCKET_EMAIL: '',
      SHIPROCKET_PASSWORD: '',
      SHIPROCKET_WEBHOOK_TOKEN: '',
    });

    expect(status, output).toBe(0);
    expect(resolved(output).drivers.shipping).toBe('manual');
  }, 60_000);

  it('refuses a Shiprocket provider row an admin switched on, and leaves manual working', async () => {
    await prisma.shippingProvider.update({
      where: { code: 'SHIPROCKET' },
      data: { isActive: true },
    });
    providerGateway.invalidate();

    try {
      await expect(providerGateway.resolve('SHIPROCKET')).rejects.toMatchObject({
        statusCode: 422,
        code: 'SHIPPING_PROVIDER_DISABLED',
      });
      await expect(providerGateway.resolve('MANUAL')).resolves.toMatchObject({
        row: { code: 'MANUAL' },
      });
    } finally {
      await prisma.shippingProvider.update({
        where: { code: 'SHIPROCKET' },
        data: { isActive: false },
      });
      providerGateway.invalidate();
    }
  });
});

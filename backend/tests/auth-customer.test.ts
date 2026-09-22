import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { prisma } from '../src/config/prisma';
import { createApp } from '../src/app';
import { otpService } from '../src/modules/auth/otp.service';

const app = createApp();

async function requestOtp(destination: string, purpose = 'LOGIN') {
  const payload = destination.includes('@') ? { email: destination } : { phone: destination };
  return request(app)
    .post('/api/v1/auth/otp/request')
    .send({ ...payload, purpose });
}

/** The cooldown is real, so tests that need a second code clear the previous challenge first. */
async function clearChallenges(destination: string): Promise<void> {
  await prisma.otpChallenge.deleteMany({ where: { destination } });
}

describe('customer OTP flow', () => {
  it('issues a code and returns devCode outside production', async () => {
    const destination = '919820000101';
    await clearChallenges(destination);

    const response = await requestOtp(destination);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ destination, channel: 'SMS' });
    expect(response.body.data.devCode).toMatch(/^[0-9]{6}$/);
    expect(response.body.data.expiresInSeconds).toBe(300);
  });

  it('signs in and creates the account when the destination is new', async () => {
    const destination = '919820000102';
    await clearChallenges(destination);
    await prisma.customer.deleteMany({ where: { phone: destination } });

    const issued = await requestOtp(destination);
    const verified = await request(app).post('/api/v1/auth/otp/verify').send({
      destination,
      code: issued.body.data.devCode,
      purpose: 'LOGIN',
      name: 'Otp Newcomer',
    });

    expect(verified.status).toBe(200);
    expect(verified.body.data.isNewAccount).toBe(true);
    expect(verified.body.data.customer.phone).toBe(destination);
    expect(verified.body.data.customer.phoneVerified).toBe(true);
    expect(JSON.stringify(verified.body)).not.toContain('refreshToken');

    const cookies = verified.headers['set-cookie'] as unknown as string[];
    expect(
      cookies.some((cookie) => cookie.startsWith('cw_cus_rt=') && cookie.includes('HttpOnly')),
    ).toBe(true);
  });

  it('is single-use — the same code cannot be replayed', async () => {
    const destination = '919820000103';
    await clearChallenges(destination);

    const issued = await requestOtp(destination);
    const code = issued.body.data.devCode as string;

    const first = await request(app)
      .post('/api/v1/auth/otp/verify')
      .send({ destination, code, purpose: 'LOGIN' });
    expect(first.status).toBe(200);

    const replay = await request(app)
      .post('/api/v1/auth/otp/verify')
      .send({ destination, code, purpose: 'LOGIN' });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('OTP_INVALID');
  });

  it('counts wrong attempts and blocks after the cap', async () => {
    const destination = '919820000104';
    await clearChallenges(destination);
    await requestOtp(destination);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ destination, code: '000000', purpose: 'LOGIN' });
      expect(response.status).toBe(400);
      expect(response.body.error.details.attemptsRemaining).toBe(5 - attempt);
    }

    const fifth = await request(app)
      .post('/api/v1/auth/otp/verify')
      .send({ destination, code: '000000', purpose: 'LOGIN' });
    expect(fifth.status).toBe(429);
    expect(fifth.body.error.code).toBe('OTP_ATTEMPTS_EXCEEDED');

    const sixth = await request(app)
      .post('/api/v1/auth/otp/verify')
      .send({ destination, code: '000000', purpose: 'LOGIN' });
    expect(sixth.status).toBe(400);
  });

  it('enforces the resend cooldown', async () => {
    const destination = '919820000105';
    await clearChallenges(destination);

    expect((await requestOtp(destination)).status).toBe(200);

    const tooSoon = await requestOtp(destination);
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.error.code).toBe('OTP_RESEND_TOO_SOON');
    expect(tooSoon.body.error.details.resendAfterSeconds).toBeGreaterThan(0);
  });

  it('rejects an expired challenge', async () => {
    const destination = '919820000106';
    await clearChallenges(destination);

    const issued = await otpService.issue({ destination, purpose: 'LOGIN' });
    await prisma.otpChallenge.updateMany({
      where: { destination },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await request(app)
      .post('/api/v1/auth/otp/verify')
      .send({ destination, code: issued.devCode, purpose: 'LOGIN' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('OTP_INVALID');
  });

  it('refuses to sign in a blocked customer', async () => {
    const destination = '919810000003';
    await clearChallenges(destination);

    const response = await requestOtp(destination);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('customer password auth', () => {
  it('signs in the seeded demo customer and returns a cookie session', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: 'aarav.mehta@example.com', password: 'CustomerDemo@2026' });

    expect(response.status).toBe(200);
    expect(response.body.data.customer.email).toBe('aarav.mehta@example.com');
    expect(response.body.data.tokens.tokenType).toBe('Bearer');

    const cookies = response.headers['set-cookie'] as unknown as string[];
    expect(cookies.map((cookie) => cookie.split('=')[0])).toEqual(
      expect.arrayContaining(['cw_cus_at', 'cw_cus_rt', 'cw_cus_csrf']),
    );
  });

  it('answers identically for a wrong password and an unknown account', async () => {
    const wrong = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: 'aarav.mehta@example.com', password: 'not-the-password' });
    const unknown = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: 'nobody@example.com', password: 'not-the-password' });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('exposes /me only to a valid customer token', async () => {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: 'aarav.mehta@example.com', password: 'CustomerDemo@2026' });

    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${login.body.data.tokens.accessToken}`);

    expect(me.status).toBe(200);
    expect(me.body.data.customer.name).toBe('Aarav Mehta');

    const anonymous = await request(app).get('/api/v1/auth/me');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('NOT_AUTHENTICATED');
  });

  it('registers a new customer and enforces the password policy', async () => {
    await prisma.customer.deleteMany({ where: { email: 'new.signup@example.com' } });

    const weak = await request(app).post('/api/v1/auth/register').send({
      name: 'Weak Password',
      email: 'new.signup@example.com',
      password: 'password123',
    });
    expect(weak.status).toBe(422);

    const created = await request(app).post('/api/v1/auth/register').send({
      name: 'New Signup',
      email: 'new.signup@example.com',
      password: 'Boucle-Linen-2026',
    });

    expect(created.status).toBe(201);
    expect(created.body.data.customer.email).toBe('new.signup@example.com');

    const duplicate = await request(app).post('/api/v1/auth/register').send({
      name: 'New Signup',
      email: 'new.signup@example.com',
      password: 'Boucle-Linen-2026',
    });
    expect(duplicate.status).toBe(409);
  });

  it('requires an email address or a phone number', async () => {
    const response = await request(app).post('/api/v1/auth/register').send({ name: 'Nameless' });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('customer session rotation', () => {
  it('rotates over the cookie and kills the family on replay', async () => {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: 'aarav.mehta@example.com', password: 'CustomerDemo@2026' });

    const cookies = login.headers['set-cookie'] as unknown as string[];
    const header = cookies.map((cookie) => cookie.split(';')[0]).join('; ');
    const csrf = cookies
      .find((cookie) => cookie.startsWith('cw_cus_csrf='))!
      .split(';')[0]
      .split('=')[1];

    const rotated = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', header)
      .set('X-CSRF-Token', csrf)
      .send({});
    expect(rotated.status).toBe(200);

    const replay = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', header)
      .set('X-CSRF-Token', csrf)
      .send({});

    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('TOKEN_REUSE');
  });
});

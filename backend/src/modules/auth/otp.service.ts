import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

import type { OtpChannel, OtpPurpose } from '@shared/enums';

import { env, otpDevCodeEnabled } from '../../config/env';
import { otpSender } from '../../container';
import { otpChallengeRepository } from '../../repositories/otpChallenge.repository';
import { AppError } from '../../utils/AppError';

/**
 * Six-digit codes, hashed at rest, single-use, rate-limited on both send and verify.
 * Comparison is constant time so the code cannot be guessed digit by digit.
 */

export interface OtpIssueResult {
  destination: string;
  channel: OtpChannel;
  expiresInSeconds: number;
  resendAfterSeconds: number;
  /** Development only — this is what makes the flow testable without an SMS provider. */
  devCode?: string;
}

function hashCode(code: string, destination: string): string {
  return createHash('sha256').update(`${destination}:${code}`).digest('hex');
}

function equals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function generateCode(length: number): string {
  const max = 10 ** length;
  return String(randomInt(0, max)).padStart(length, '0');
}

export const otpService = {
  channelFor(destination: string): OtpChannel {
    return destination.includes('@') ? 'EMAIL' : 'SMS';
  },

  async issue(input: {
    destination: string;
    purpose: OtpPurpose;
    channel?: OtpChannel;
    principalType?: string | null;
    principalId?: string | null;
    ip?: string | null;
  }): Promise<OtpIssueResult> {
    const destination = input.destination.trim().toLowerCase();
    const channel = input.channel ?? this.channelFor(destination);

    const latest = await otpChallengeRepository.findLatest(destination, input.purpose);
    if (latest) {
      const elapsed = (Date.now() - latest.lastSentAt.getTime()) / 1000;
      if (elapsed < env.OTP_RESEND_COOLDOWN_SECONDS) {
        throw new AppError(
          429,
          'OTP_RESEND_TOO_SOON',
          `Please wait ${Math.ceil(env.OTP_RESEND_COOLDOWN_SECONDS - elapsed)}s before asking for another code`,
          { resendAfterSeconds: Math.ceil(env.OTP_RESEND_COOLDOWN_SECONDS - elapsed) },
        );
      }
    }

    const hourAgo = new Date(Date.now() - 3_600_000);
    const sentThisHour = await otpChallengeRepository.countSince(destination, hourAgo);
    if (sentThisHour >= env.OTP_MAX_PER_HOUR) {
      throw new AppError(429, 'OTP_RATE_LIMITED', 'Too many codes requested — try again later');
    }

    await otpChallengeRepository.consumeOutstanding(destination, input.purpose);

    const code = generateCode(env.OTP_LENGTH);
    const expiresAt = new Date(Date.now() + env.OTP_TTL_SECONDS * 1000);

    await otpChallengeRepository.create({
      channel,
      purpose: input.purpose,
      destination,
      codeHash: hashCode(code, destination),
      principalType: input.principalType ?? null,
      principalId: input.principalId ?? null,
      maxAttempts: env.OTP_MAX_ATTEMPTS,
      expiresAt,
      resendCount: sentThisHour,
      ip: input.ip ?? null,
    });

    await otpSender.send({
      channel,
      destination,
      code,
      message: `${code} is your ClearWood verification code. It expires in ${Math.round(env.OTP_TTL_SECONDS / 60)} minutes.`,
    });

    return {
      destination,
      channel,
      expiresInSeconds: env.OTP_TTL_SECONDS,
      resendAfterSeconds: env.OTP_RESEND_COOLDOWN_SECONDS,
      ...(otpDevCodeEnabled ? { devCode: code } : {}),
    };
  },

  /** Consumes the challenge on success; increments attempts and blocks after the cap on failure. */
  async verify(destination: string, code: string, purpose: OtpPurpose): Promise<void> {
    const normalised = destination.trim().toLowerCase();
    const challenge = await otpChallengeRepository.findActive(normalised, purpose);

    if (!challenge) {
      throw new AppError(400, 'OTP_INVALID', 'That code is invalid or has expired');
    }

    if (challenge.attempts >= challenge.maxAttempts) {
      throw new AppError(429, 'OTP_ATTEMPTS_EXCEEDED', 'Too many attempts — request a new code');
    }

    if (!equals(challenge.codeHash, hashCode(code, normalised))) {
      const attempts = challenge.attempts + 1;
      await otpChallengeRepository.update(challenge.id, {
        attempts,
        ...(attempts >= challenge.maxAttempts ? { consumedAt: new Date() } : {}),
      });

      if (attempts >= challenge.maxAttempts) {
        throw new AppError(429, 'OTP_ATTEMPTS_EXCEEDED', 'Too many attempts — request a new code');
      }
      throw new AppError(400, 'OTP_INVALID', 'That code is invalid or has expired', {
        attemptsRemaining: challenge.maxAttempts - attempts,
      });
    }

    await otpChallengeRepository.update(challenge.id, { consumedAt: new Date() });
  },
};

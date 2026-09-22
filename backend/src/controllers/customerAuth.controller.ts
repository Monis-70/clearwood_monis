import type { Request, Response } from 'express';

import type {
  ChangePasswordInput,
  CustomerLoginInput,
  CustomerProfileUpdateInput,
  CustomerRegisterInput,
  OtpRequestInput,
  OtpVerifyInput,
  RefreshInput,
  ResetPasswordInput,
} from '@shared/schemas/auth';

import { customerAuthService } from '../modules/auth/customer-auth.service';
import { ok } from '../utils/response';

export const customerAuthController = {
  async register(req: Request, res: Response): Promise<void> {
    const result = await customerAuthService.register(req, res, req.body as CustomerRegisterInput);
    ok(
      res,
      {
        customer: result.customer,
        tokens: {
          accessToken: result.accessToken,
          expiresIn: result.expiresIn,
          tokenType: 'Bearer',
        },
      },
      null,
      201,
    );
  },

  async login(req: Request, res: Response): Promise<void> {
    const result = await customerAuthService.login(req, res, req.body as CustomerLoginInput);
    ok(res, {
      customer: result.customer,
      tokens: { accessToken: result.accessToken, expiresIn: result.expiresIn, tokenType: 'Bearer' },
    });
  },

  async requestOtp(req: Request, res: Response): Promise<void> {
    ok(res, await customerAuthService.requestOtp(req, req.body as OtpRequestInput));
  },

  async verifyOtp(req: Request, res: Response): Promise<void> {
    const result = await customerAuthService.verifyOtp(req, res, req.body as OtpVerifyInput);
    ok(res, {
      customer: result.customer,
      isNewAccount: result.isNewAccount,
      tokens: { accessToken: result.accessToken, expiresIn: result.expiresIn, tokenType: 'Bearer' },
    });
  },

  async refresh(req: Request, res: Response): Promise<void> {
    const { refreshToken } = (req.body ?? {}) as RefreshInput;
    const result = await customerAuthService.refresh(req, res, refreshToken);
    ok(res, {
      customer: result.customer,
      tokens: { accessToken: result.accessToken, expiresIn: result.expiresIn, tokenType: 'Bearer' },
    });
  },

  async logout(req: Request, res: Response): Promise<void> {
    await customerAuthService.logout(req, res);
    ok(res, { loggedOut: true });
  },

  async me(req: Request, res: Response): Promise<void> {
    ok(res, { customer: await customerAuthService.me(req.auth!.principalId) });
  },

  async updateProfile(req: Request, res: Response): Promise<void> {
    const customer = await customerAuthService.updateProfile(
      req,
      req.body as CustomerProfileUpdateInput,
    );
    ok(res, { customer });
  },

  async changePassword(req: Request, res: Response): Promise<void> {
    await customerAuthService.changePassword(req, req.body as ChangePasswordInput);
    ok(res, { changed: true });
  },

  /** Always 200 — identical for known and unknown addresses. */
  async forgotPassword(req: Request, res: Response): Promise<void> {
    await customerAuthService.forgotPassword((req.body as { email: string }).email);
    ok(res, { sent: true });
  },

  async resetPassword(req: Request, res: Response): Promise<void> {
    await customerAuthService.resetPassword(req, req.body as ResetPasswordInput);
    ok(res, { reset: true });
  },

  async sendEmailVerification(req: Request, res: Response): Promise<void> {
    await customerAuthService.sendEmailVerification(req);
    ok(res, { sent: true });
  },

  async verifyEmail(req: Request, res: Response): Promise<void> {
    const customer = await customerAuthService.verifyEmail((req.body as { token: string }).token);
    ok(res, { customer });
  },
};

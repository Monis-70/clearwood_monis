import { Router } from 'express';

import { API_PREFIX } from '@shared/constants';
import {
  changePasswordSchema,
  customerForgotPasswordSchema,
  customerLoginSchema,
  customerProfileUpdateSchema,
  customerRegisterSchema,
  emailVerifySchema,
  otpRequestSchema,
  otpVerifySchema,
  refreshSchema,
  resetPasswordSchema,
} from '@shared/schemas/auth';

import { customerAuthController } from '../controllers/customerAuth.controller';
import {
  commonErrorResponses,
  errorBodySchema,
  jsonContent,
  registry,
  successBodySchema,
  z,
} from '../docs/registry';
import { asyncHandler, authenticate, authRateLimit, optionalAuth, validate } from '../middleware';
import { csrfProtection } from '../modules/auth/csrf.service';

const guard = [authenticate('CUSTOMER'), csrfProtection('CUSTOMER')];
const unauthorised = { 401: jsonContent(errorBodySchema, 'Not authenticated') };

const customerSchema = registry.register(
  'Customer',
  z.object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    status: z.string(),
    emailVerified: z.boolean(),
    phoneVerified: z.boolean(),
    marketingOptIn: z.boolean(),
    acceptsWhatsapp: z.boolean(),
    avatarMediaId: z.string().nullable(),
    referralCode: z.string().nullable(),
    createdAt: z.string(),
  }),
);

const customerSessionSchema = registry.register(
  'CustomerSession',
  z.object({
    customer: customerSchema,
    isNewAccount: z.boolean().optional(),
    tokens: z.object({
      accessToken: z.string(),
      expiresIn: z.number().int(),
      tokenType: z.literal('Bearer'),
    }),
  }),
);

const otpResponseSchema = registry.register(
  'OtpChallenge',
  z.object({
    destination: z.string(),
    channel: z.string(),
    expiresInSeconds: z.number().int(),
    resendAfterSeconds: z.number().int(),
    devCode: z
      .string()
      .optional()
      .openapi({ description: 'Development only — absent when NODE_ENV=production.' }),
  }),
);

function path(suffix: string): string {
  return `${API_PREFIX}/auth${suffix}`;
}

registry.registerPath({
  method: 'post',
  path: path('/login'),
  tags: ['Customer auth'],
  summary: 'Sign in with email or phone plus password',
  description: 'Sets cw_cus_at / cw_cus_rt (httpOnly) and cw_cus_csrf (readable) on `/`.',
  request: { body: { content: { 'application/json': { schema: customerLoginSchema } } } },
  responses: {
    200: jsonContent(successBodySchema(customerSessionSchema), 'Signed in'),
    ...unauthorised,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: path('/register'),
  tags: ['Customer auth'],
  summary: 'Create a storefront account',
  request: { body: { content: { 'application/json': { schema: customerRegisterSchema } } } },
  responses: {
    201: jsonContent(successBodySchema(customerSessionSchema), 'Account created'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: path('/otp/request'),
  tags: ['Customer auth'],
  summary: 'Send a one-time code',
  description: `Rate limited: one code per cooldown window, capped per hour and per destination.`,
  request: { body: { content: { 'application/json': { schema: otpRequestSchema } } } },
  responses: {
    200: jsonContent(successBodySchema(otpResponseSchema), 'Code dispatched'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: path('/otp/verify'),
  tags: ['Customer auth'],
  summary: 'Verify a code — signs in, or creates the account if the destination is new',
  request: { body: { content: { 'application/json': { schema: otpVerifySchema } } } },
  responses: {
    200: jsonContent(successBodySchema(customerSessionSchema), 'Signed in'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: path('/refresh'),
  tags: ['Customer auth'],
  summary: 'Rotate the storefront session',
  description:
    'Reads the httpOnly cw_cus_rt cookie. The optional body field is for REST Client/tests only ' +
    'and is rejected in production.',
  request: { body: { content: { 'application/json': { schema: refreshSchema } } } },
  responses: {
    200: jsonContent(successBodySchema(customerSessionSchema), 'Rotated'),
    ...unauthorised,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: path('/me'),
  tags: ['Customer auth'],
  summary: 'The signed-in customer',
  responses: {
    200: jsonContent(successBodySchema(z.object({ customer: customerSchema })), 'Current customer'),
    ...unauthorised,
    ...commonErrorResponses,
  },
});

export const customerAuthRouter: Router = Router();

customerAuthRouter.post(
  '/auth/register',
  authRateLimit('customer-register'),
  validate({ body: customerRegisterSchema }),
  asyncHandler(customerAuthController.register),
);

customerAuthRouter.post(
  '/auth/login',
  authRateLimit('customer-login'),
  validate({ body: customerLoginSchema }),
  asyncHandler(customerAuthController.login),
);

customerAuthRouter.post(
  '/auth/otp/request',
  authRateLimit('customer-otp'),
  validate({ body: otpRequestSchema }),
  asyncHandler(customerAuthController.requestOtp),
);

customerAuthRouter.post(
  '/auth/otp/verify',
  authRateLimit('customer-otp-verify'),
  validate({ body: otpVerifySchema }),
  asyncHandler(customerAuthController.verifyOtp),
);

customerAuthRouter.post(
  '/auth/refresh',
  authRateLimit('customer-refresh'),
  validate({ body: refreshSchema }),
  asyncHandler(customerAuthController.refresh),
);

customerAuthRouter.post(
  '/auth/logout',
  optionalAuth('CUSTOMER'),
  csrfProtection('CUSTOMER'),
  asyncHandler(customerAuthController.logout),
);

customerAuthRouter.post(
  '/auth/forgot-password',
  authRateLimit('customer-forgot'),
  validate({ body: customerForgotPasswordSchema }),
  asyncHandler(customerAuthController.forgotPassword),
);

customerAuthRouter.post(
  '/auth/reset-password',
  authRateLimit('customer-reset'),
  validate({ body: resetPasswordSchema }),
  asyncHandler(customerAuthController.resetPassword),
);

customerAuthRouter.post(
  '/auth/email/verify',
  authRateLimit('customer-verify-email'),
  validate({ body: emailVerifySchema }),
  asyncHandler(customerAuthController.verifyEmail),
);

customerAuthRouter.get(
  '/auth/me',
  authenticate('CUSTOMER'),
  asyncHandler(customerAuthController.me),
);

customerAuthRouter.patch(
  '/auth/me',
  ...guard,
  validate({ body: customerProfileUpdateSchema }),
  asyncHandler(customerAuthController.updateProfile),
);

customerAuthRouter.post(
  '/auth/change-password',
  ...guard,
  validate({ body: changePasswordSchema }),
  asyncHandler(customerAuthController.changePassword),
);

customerAuthRouter.post(
  '/auth/email/send-verification',
  ...guard,
  asyncHandler(customerAuthController.sendEmailVerification),
);

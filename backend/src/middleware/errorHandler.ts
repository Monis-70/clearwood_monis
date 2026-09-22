import { Prisma } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import type { ApiErrorBody } from '@shared/types/api';

import { isProduction } from '../config/env';
import { logger } from '../config/logger';
import { AppError, isAppError } from '../utils/AppError';

import { getRequestId } from './requestId';

interface NormalisedError {
  statusCode: number;
  code: string;
  message: string;
  details: unknown | null;
  isOperational: boolean;
}

function fromZodError(error: ZodError): NormalisedError {
  return {
    statusCode: 422,
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed',
    details: error.issues.map((issue) => ({
      path: issue.path.join('.'),
      code: issue.code,
      message: issue.message,
    })),
    isOperational: true,
  };
}

function fromPrismaKnownError(error: Prisma.PrismaClientKnownRequestError): NormalisedError {
  switch (error.code) {
    case 'P2002':
      return {
        statusCode: 409,
        code: 'DUPLICATE_RESOURCE',
        message: 'A record with these unique values already exists',
        details: { target: error.meta?.target ?? null },
        isOperational: true,
      };
    case 'P2025':
      return {
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'The requested record does not exist',
        details: null,
        isOperational: true,
      };
    case 'P2003':
      return {
        statusCode: 409,
        code: 'FOREIGN_KEY_CONSTRAINT',
        message: 'A related record prevents this operation',
        details: { field: error.meta?.field_name ?? null },
        isOperational: true,
      };
    default:
      return {
        statusCode: 400,
        code: 'DATABASE_ERROR',
        message: 'The database rejected this operation',
        details: { prismaCode: error.code },
        isOperational: true,
      };
  }
}

function normalise(error: unknown): NormalisedError {
  if (isAppError(error)) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      details: error.details,
      isOperational: error.isOperational,
    };
  }

  if (error instanceof ZodError) return fromZodError(error);

  if (error instanceof Prisma.PrismaClientKnownRequestError) return fromPrismaKnownError(error);

  if (error instanceof Prisma.PrismaClientValidationError) {
    return {
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      message: 'The query sent to the database was not valid',
      details: null,
      isOperational: true,
    };
  }

  if (typeof error === 'object' && error !== null && 'type' in error) {
    const bodyParserType = (error as { type?: string }).type;
    if (bodyParserType === 'entity.parse.failed') {
      return {
        statusCode: 400,
        code: 'INVALID_JSON',
        message: 'Request body is not valid JSON',
        details: null,
        isOperational: true,
      };
    }
    if (bodyParserType === 'entity.too.large') {
      return {
        statusCode: 413,
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body exceeds the 2mb limit',
        details: null,
        isOperational: true,
      };
    }
  }

  return {
    statusCode: 500,
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Something went wrong',
    details: null,
    isOperational: false,
  };
}

/**
 * R3 + R4 — the ONE place an error becomes a response. Nothing else in the codebase may write an
 * error body. Stack traces are logged, never returned (and never returned at all in production).
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const traceId = getRequestId(req);
  const normalised = normalise(error);

  const logPayload = {
    traceId,
    method: req.method,
    url: req.originalUrl,
    statusCode: normalised.statusCode,
    code: normalised.code,
    err: error instanceof Error ? { message: error.message, stack: error.stack } : error,
  };

  if (normalised.statusCode >= 500 || !normalised.isOperational) {
    logger.error(logPayload, 'request failed');
  } else {
    logger.warn(logPayload, 'request rejected');
  }

  const details =
    !isProduction && !normalised.isOperational && error instanceof Error
      ? { hint: error.message }
      : normalised.details;

  const body: ApiErrorBody = {
    success: false,
    error: {
      code: normalised.code,
      message: normalised.message,
      details: details ?? null,
      traceId,
    },
  };

  if (res.headersSent) {
    res.end();
    return;
  }

  res.status(normalised.statusCode).json(body);
}

/** Re-exported so callers can build the same envelope shape from outside a route (e.g. CORS). */
export { AppError };

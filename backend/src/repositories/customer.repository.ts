import type { Customer, Prisma } from '@prisma/client';

import { prisma } from '../config/prisma';

import { notDeleted } from './helpers';

export const customerRepository = {
  findById(id: string): Promise<Customer | null> {
    return prisma.customer.findFirst({ where: { id, ...notDeleted } });
  },

  findByEmail(email: string): Promise<Customer | null> {
    return prisma.customer.findFirst({ where: { email: email.toLowerCase(), ...notDeleted } });
  },

  findByPhone(phone: string): Promise<Customer | null> {
    return prisma.customer.findFirst({ where: { phone, ...notDeleted } });
  },

  /** Email or phone — the caller does not need to know which the identifier is. */
  findByIdentifier(identifier: string): Promise<Customer | null> {
    const value = identifier.trim();
    return value.includes('@') ? this.findByEmail(value) : this.findByPhone(value);
  },

  create(data: Prisma.CustomerUncheckedCreateInput): Promise<Customer> {
    return prisma.customer.create({ data });
  },

  update(id: string, data: Prisma.CustomerUncheckedUpdateInput): Promise<Customer> {
    return prisma.customer.update({ where: { id }, data });
  },

  registerFailedLogin(id: string, lockedUntil: Date | null): Promise<Customer> {
    return prisma.customer.update({
      where: { id },
      data: { failedLoginCount: { increment: 1 }, lockedUntil },
    });
  },

  registerSuccessfulLogin(id: string): Promise<Customer> {
    return prisma.customer.update({
      where: { id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
  },

  count(): Promise<number> {
    return prisma.customer.count({ where: notDeleted });
  },
};

// Prisma queries on the user model: three violations, three compliant queries.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function listBad() {
  return prisma.user.findMany(); // VIOLATION prisma-findMany
}

export async function getBad(id: string) {
  return prisma.user.findUnique({ where: { id }, include: { orders: true } }); // VIOLATION prisma-findUnique
}

export async function createBad(email: string) {
  return prisma.user.create({ data: { email } }); // VIOLATION prisma-create
}

export async function listGood() {
  return prisma.user.findMany({ select: { id: true, email: true }, take: 20 });
}

export async function firstGood(email: string) {
  return prisma.user.findFirst({ where: { email }, select: { id: true } });
}

export async function updateGood(id: string, email: string) {
  return prisma.user.update({ where: { id }, data: { email }, select: { id: true, email: true } });
}

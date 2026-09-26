// Idempotent: accounts upserted by code (opening balances untouched), categories created if missing.
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? 'postgres://plata:plata@localhost:5433/plata' }),
});

const accounts = [
  { code: 'binance', name: 'Binance', currency: 'USDT', kind: 'synced', payMethodAliases: [] },
  { code: 'mercantil', name: 'Mercantil', currency: 'VES', kind: 'ledger', payMethodAliases: ['Mercantil', 'BancoMercantil', 'Banco Mercantil'] },
  { code: 'bdv', name: 'BDV', currency: 'VES', kind: 'ledger', payMethodAliases: ['BDV', 'Banco de Venezuela', 'BancoDeVenezuela', 'BancodeVenezuela'] },
  { code: 'cash_usd', name: 'Efectivo USD', currency: 'USD', kind: 'ledger', payMethodAliases: [] },
  { code: 'zelle', name: 'Zelle', currency: 'USD', kind: 'ledger', payMethodAliases: [] },
  { code: 'cash_ves', name: 'Efectivo Bs', currency: 'VES', kind: 'ledger', payMethodAliases: [] },
];

// [name, emoji, children?]
const tree: [string, string, [string, string][]?][] = [
  ['Comida', '🍽️', [['Mercado', '🛒'], ['Restaurantes', '🍴'], ['Panadería', '🥖'], ['Delivery', '🛵']]],
  ['Transporte', '🚗', [['Gasolina', '⛽'], ['Taxi-Ridery', '🚕'], ['Mantenimiento', '🔧']]],
  ['Casa', '🏠', [['Alquiler', '🔑'], ['Servicios', '💡'], ['Condominio', '🏢'], ['Internet', '🌐'], ['Teléfono', '📱']]],
  ['Salud', '💊'], ['Personal', '🧴'], ['Mascotas', '🐱'], ['Ocio', '🎉'], ['Suscripciones', '📺'], ['Educación', '📚'],
  ['Regalos', '🎁'], ['Comisiones', '🏦'], ['Préstamos', '🤝'], ['Deudas', '💳', [['Tarjeta de crédito', '💳']]], ['Otros', '📦'],
];

// Randy's monthly plan (his spreadsheet, in USDT). Only seeded while the plan is empty; due days are set later from the bot/panel.
// [name, emoji, kind, amount, category path]
const plan: [string, string, 'bill' | 'envelope', number, string][] = [
  ['Alquiler', '🔑', 'bill', 300, 'Casa › Alquiler'],
  ['Almuerzos', '🍴', 'envelope', 100, 'Comida › Restaurantes'],
  ['Mercado', '🛒', 'envelope', 200, 'Comida › Mercado'],
  ['Gasolina', '⛽', 'envelope', 70, 'Transporte › Gasolina'],
  ['Starlink', '🛰️', 'bill', 55, 'Casa › Internet'],
  ['Internet', '🌐', 'bill', 25, 'Casa › Internet'],
  ['Movistar', '📱', 'bill', 10, 'Casa › Teléfono'],
  ['Digitel', '📱', 'bill', 10, 'Casa › Teléfono'],
  ['Minecraft', '🎮', 'bill', 22, 'Suscripciones'],
  ['Google One', '☁️', 'bill', 10, 'Suscripciones'],
  ['Odontólogo', '🦷', 'bill', 80, 'Salud'],
  ['Gatos', '🐱', 'envelope', 60, 'Mascotas'],
  ['Lavada de carro', '🚿', 'bill', 10, 'Transporte › Mantenimiento'],
  ['Luz', '💡', 'bill', 15, 'Casa › Servicios'],
  ['Corte de cabello', '💈', 'bill', 10, 'Personal'],
];

async function catByPath(path: string) {
  const [a, b] = path.split(' › ');
  const top = await db.category.findFirst({ where: { name: a, parentId: null } });
  return b && top ? db.category.findFirst({ where: { name: b, parentId: top.id } }) : top;
}

async function cat(name: string, emoji: string, parentId: number | null) {
  const found = await db.category.findFirst({ where: { name, parentId } });
  return found ?? db.category.create({ data: { name, emoji, parentId } });
}

async function main() {
  for (const { code, ...a } of accounts) await db.account.upsert({ where: { code }, create: { code, ...a }, update: a });
  for (const [name, emoji, kids = []] of tree) {
    const parent = await cat(name, emoji, null);
    for (const [k, e] of kids) await cat(k, e, parent.id);
  }
  if (!(await db.planItem.count())) {
    for (const [i, [name, emoji, kind, amount, path]] of plan.entries())
      await db.planItem.create({ data: { name, emoji, kind, amount, currency: 'USDT', categoryId: (await catByPath(path))?.id, sort: i + 1 } });
  }
  console.log(`seeded ${accounts.length} accounts, ${await db.category.count()} categories, ${await db.planItem.count()} plan items`);
}

main().finally(() => db.$disconnect());

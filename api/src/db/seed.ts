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
  ['Casa', '🏠', [['Servicios', '💡'], ['Condominio', '🏢'], ['Internet', '🌐']]],
  ['Salud', '💊'], ['Personal', '🧴'], ['Ocio', '🎉'], ['Suscripciones', '📺'], ['Educación', '📚'],
  ['Regalos', '🎁'], ['Comisiones', '🏦'], ['Préstamos', '🤝'], ['Deudas', '💳', [['Tarjeta de crédito', '💳']]], ['Otros', '📦'],
];

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
  console.log(`seeded ${accounts.length} accounts, ${await db.category.count()} categories`);
}

main().finally(() => db.$disconnect());

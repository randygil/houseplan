import { Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import type { Category, MerchantRule } from '../generated/prisma/client';

export const norm = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

@Injectable()
export class CategoriesService {
  constructor(private db: PrismaService) {}

  async list(): Promise<(Category & { path: string })[]> {
    const all = await this.db.category.findMany({ orderBy: [{ parentId: 'asc' }, { name: 'asc' }] });
    const byId = new Map(all.map((c) => [c.id, c]));
    const path = (c: Category): string => {
      const p = c.parentId ? byId.get(c.parentId) : undefined;
      return p ? `${path(p)} › ${c.name}` : c.name;
    };
    return all.map((c) => ({ ...c, path: path(c) })).sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Accepts "Comida › Panadería", "comida/panaderia", "panaderia". */
  async byPath(input: string): Promise<Category | null> {
    const segs = input.split(/›|>|\//).map(norm).filter(Boolean);
    if (!segs.length) return null;
    const all = await this.list();
    const want = segs.join('/');
    const exact = all.find((c) => c.path.split('›').map(norm).join('/') === want);
    if (exact) return exact;
    const leaf = all.filter((c) => norm(c.name) === segs[segs.length - 1]);
    return leaf.find((c) => norm(c.path).startsWith(segs[0])) ?? leaf[0] ?? null;
  }

  ruleFor(merchant: string): Promise<MerchantRule | null> {
    return this.db.merchantRule.findUnique({ where: { pattern: norm(merchant) } });
  }

  async learn(merchant: string, categoryId: number, accountId?: number): Promise<void> {
    const pattern = norm(merchant);
    if (!pattern) return;
    await this.db.merchantRule.upsert({
      where: { pattern },
      create: { pattern, categoryId, accountId },
      update: { categoryId, accountId, hits: { increment: 1 } },
    });
  }
}

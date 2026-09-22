import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';

// Local multilingual-e5-small (384 dims). Omniroute /v1/embeddings has no provider credentials (probed 2026-09).
// e5 wants "query: " / "passage: " prefixes. Model (~120MB) downloads on first use into the HF cache.
@Injectable()
export class EmbeddingsService {
  private log = new Logger('Embeddings');
  private extractor?: Promise<any>;
  private disabled = false;

  constructor(private db: PrismaService) {}

  private async embed(text: string): Promise<number[] | null> {
    if (this.disabled) return null;
    try {
      this.extractor ??= import('@huggingface/transformers').then((t) => {
        if (process.env.HF_CACHE) t.env.cacheDir = process.env.HF_CACHE;
        return t.pipeline('feature-extraction', 'Xenova/multilingual-e5-small', { dtype: 'q8' });
      });
      const out = await (await this.extractor)(text, { pooling: 'mean', normalize: true });
      return Array.from(out.data as Float32Array);
    } catch (e) {
      this.disabled = true; // don't retry a failed download on every tx; restart to retry
      this.log.warn(`embeddings desactivados: ${(e as Error).message}`);
      return null;
    }
  }

  async upsertFor(ownerType: string, ownerId: number, content: string): Promise<void> {
    const v = await this.embed(`passage: ${content}`);
    if (!v) return;
    const vec = `[${v.join(',')}]`;
    await this.db.$executeRaw`
      INSERT INTO embeddings ("ownerType", "ownerId", content, embedding)
      VALUES (${ownerType}, ${ownerId}, ${content}, ${vec}::vector)
      ON CONFLICT ("ownerType", "ownerId") DO UPDATE SET content = EXCLUDED.content, embedding = EXCLUDED.embedding`;
  }

  async search(query: string, k = 5): Promise<{ ownerType: string; ownerId: number; content: string; score: number }[]> {
    const v = await this.embed(`query: ${query}`);
    if (!v) return [];
    const vec = `[${v.join(',')}]`;
    const rows = await this.db.$queryRaw<{ ownerType: string; ownerId: number; content: string; score: number }[]>`
      SELECT "ownerType", "ownerId", content, 1 - (embedding <=> ${vec}::vector) AS score
      FROM embeddings ORDER BY embedding <=> ${vec}::vector LIMIT ${k}`;
    return rows.map((r) => ({ ...r, score: Number(r.score) }));
  }
}

import { Injectable, Logger } from '@nestjs/common';

export type Msg = { role: 'system' | 'user' | 'assistant'; content: string | object[] };

/** Models wrap JSON in ```fences``` or a courtesy sentence: keep first bracket to last. */
export function unfence(s: string): string {
  const t = String(s).replace(/```[a-z]*/gi, '').trim();
  const a = t.search(/[[{]/);
  if (a < 0) return t;
  const b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  return b > a ? t.slice(a, b + 1) : t.slice(a);
}

// Omniroute is OpenAI-compatible, but (probed 2026-09) it drops `tools`/`tool_calls`, so tool use is a JSON
// action loop (see AskService). `stream:false` is mandatory or it answers SSE.
@Injectable()
export class LlmService {
  private log = new Logger('Llm');
  readonly model = process.env.OMNI_MODEL || 'antigravity/gemini-2.5-flash';
  readonly smart = process.env.OMNI_SMART_MODEL || 'antigravity/claude-sonnet-5';
  readonly vision = process.env.OMNI_VISION_MODEL || this.model;

  async chat(messages: Msg[], model = this.model, max_tokens = 1500): Promise<string> {
    const key = process.env.OMNI_KEY;
    if (!key) throw new Error('OMNI_KEY no configurada');
    const r = await fetch(process.env.OMNI_URL || 'https://omniroute.randygil.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, stream: false, max_tokens, temperature: 0.2, messages }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!r.ok) throw new Error(`omni ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
    const c = ((await r.json()) as any)?.choices?.[0]?.message?.content;
    const text = Array.isArray(c) ? c.map((p: any) => p?.text ?? '').join('') : c;
    if (!text) throw new Error('omni: respuesta vacía');
    return text;
  }

  /** JSON answer. One retry on the other model (flash <-> smart) if the call or the parse fails. */
  async json<T = any>(prompt: string | Msg[], schemaHint = '', model = this.model, max_tokens = 1500): Promise<T> {
    const msgs: Msg[] = typeof prompt === 'string' ? [{ role: 'user', content: prompt }] : prompt;
    const sys: Msg = { role: 'system', content: `Responde SOLO con JSON válido, sin texto extra.${schemaHint ? ` Forma: ${schemaHint}` : ''}` };
    let err: unknown;
    for (const m of [model, model === this.smart ? this.model : this.smart]) {
      try {
        return JSON.parse(unfence(await this.chat([sys, ...msgs], m, max_tokens)));
      } catch (e) {
        err = e;
        this.log.warn(`${m}: ${(e as Error).message}`);
      }
    }
    throw err;
  }

  /** Vision -> JSON. image as base64. */
  image<T = any>(prompt: string, b64: string, mime: string, schemaHint = ''): Promise<T> {
    return this.json<T>(
      [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }] }],
      schemaHint, this.vision,
    );
  }
}

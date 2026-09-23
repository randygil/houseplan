import type { Msg } from './llm.service';

export type Call = { tool: string; args?: any };
/** One model turn: `calls` to act/look, `reply` (string, "" = stay silent) to finish. Both = act and finish in one call. */
export type Step = { calls?: Call[]; reply?: string; [k: string]: unknown };
export type Tools = Record<string, (args: any) => Promise<unknown>>;

/**
 * JSON action loop (Omniroute strips native tool_calls, so no SDK agent works through it).
 * - `{calls, reply}` finishes right after running the calls: "anota 350 en pan" costs ONE model call.
 * - A failed call, or a call to a `looks` tool (data the model must read), always earns another turn.
 * - The same call twice in one run is skipped (model looping / double-registering).
 */
export async function runAgent(
  model: (msgs: Msg[]) => Promise<Step>, msgs: Msg[], tools: Tools,
  { maxSteps = 5, looks = [] as string[], maxChars = 12000 } = {},
): Promise<Step & { ran: string[] }> {
  const seen = new Set<string>();
  const ran: string[] = [];
  for (let step = 0; step < maxSteps; step++) {
    const r = await model(msgs);
    const calls = (Array.isArray(r?.calls) ? r.calls : []).filter((c) => typeof c?.tool === 'string').slice(0, 6);
    if (!calls.length) return { ...r, ran };
    if (step === maxSteps - 1) break; // out of budget: don't act on a turn we can't report back on
    const results: object[] = [];
    let again = false;
    for (const c of calls) { // sequential: order matters ("sincroniza y anota…")
      const key = JSON.stringify([c.tool, c.args ?? {}]);
      if (seen.has(key)) { results.push({ tool: c.tool, skipped: 'ya ejecutada en este turno' }); continue; }
      seen.add(key);
      const fn = tools[c.tool];
      try {
        if (!fn) throw new Error(`herramienta desconocida: ${c.tool}`);
        results.push({ tool: c.tool, result: (await fn(c.args ?? {})) ?? 'ok' });
        ran.push(c.tool);
        if (looks.includes(c.tool)) again = true;
      } catch (e) {
        results.push({ tool: c.tool, error: (e as Error).message });
        again = true;
      }
    }
    if (typeof r.reply === 'string' && !again) return { ...r, ran };
    msgs = [...msgs,
      { role: 'assistant', content: JSON.stringify({ calls }) },
      { role: 'user', content: `Resultados: ${JSON.stringify(results).slice(0, maxChars)}${step === maxSteps - 2 ? '\nÚltimo turno: responde ya con "reply", sin calls.' : ''}` }];
  }
  return { reply: 'No pude terminar eso 😅 ¿Me lo dices de otra forma?', ran };
}

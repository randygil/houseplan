import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAgent, Step } from './agent';
import type { Msg } from './llm.service';

const scripted = (steps: Step[]) => {
  const seen: Msg[][] = [];
  return { seen, model: async (m: Msg[]) => { seen.push(m); return steps[seen.length - 1] ?? { reply: 'fin' }; } };
};

test('runAgent: action + reply in one model call', async () => {
  const s = scripted([{ calls: [{ tool: 'add', args: { n: 1 } }], reply: '' }]);
  const got: unknown[] = [];
  const r = await runAgent(s.model, [], { add: async (a) => { got.push(a); return 'ok'; } });
  assert.equal(s.seen.length, 1);
  assert.deepEqual(got, [{ n: 1 }]);
  assert.equal(r.reply, '');
  assert.deepEqual(r.ran, ['add']);
});

test('runAgent: look tools and errors earn another turn; duplicate calls skipped', async () => {
  const s = scripted([
    { calls: [{ tool: 'list' }, { tool: 'boom' }], reply: 'premature' },
    { calls: [{ tool: 'list' }] },
    { reply: 'hay 2' },
  ]);
  let lists = 0;
  const r = await runAgent(s.model, [], { list: async () => ++lists, boom: async () => { throw new Error('x'); } }, { looks: ['list'] });
  assert.equal(r.reply, 'hay 2');
  assert.equal(lists, 1); // second identical call skipped
  assert.match(String(s.seen[1].at(-1)!.content), /"error":"x"/);
  assert.match(String(s.seen[2].at(-1)!.content), /skipped/);
});

test('runAgent: step budget -> fallback, last turn is told to answer', async () => {
  const s = scripted(Array(5).fill({ calls: [{ tool: 'list', args: {} }] }).map((c, i) => ({ calls: [{ tool: 'list', args: { i } }] })));
  const r = await runAgent(s.model, [], { list: async () => 1 }, { maxSteps: 3, looks: ['list'] });
  assert.equal(s.seen.length, 3);
  assert.match(String(s.seen[2].at(-1)!.content), /Último turno/);
  assert.match(r.reply!, /No pude/);
});

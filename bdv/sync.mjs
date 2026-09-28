// Logs into BDVenlínea with the real installed Chrome (not bundled Chromium), reads the account's
// movements, logs out, and posts them to the API. One attempt per run: any surprise (wrong page,
// extra challenge, timeout) aborts without retrying, so we never trip the lockout.
// Run: node --env-file=.env sync.mjs [--debug] [--dry]   (--dry: don't post to the API)
import { chromium } from 'patchright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const DEBUG = process.argv.includes('--debug');
const DRY = process.argv.includes('--dry');
const DBG = join(HERE, 'debug', new Date().toISOString().replace(/[:.]/g, '-'));
if (DEBUG) mkdirSync(DBG, { recursive: true });

const { BDV_USER, BDV_PASS, API_URL, BDV_SYNC_TOKEN } = process.env;
if (!BDV_USER || !BDV_PASS) throw new Error('BDV_USER / BDV_PASS missing in .env');
if (!DRY && (!API_URL || !BDV_SYNC_TOKEN)) throw new Error('API_URL / BDV_SYNC_TOKEN missing in .env');

const post = (body) => fetch(`${API_URL}/api/bdv/sync`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${BDV_SYNC_TOKEN}` }, body: JSON.stringify(body),
}).then(async (r) => { if (!r.ok) throw new Error(`API ${r.status}: ${await r.text()}`); return r.json(); });

const rand = (a, b) => a + Math.random() * (b - a);
const pause = (a = 600, b = 1800) => page.waitForTimeout(rand(a, b));
// BDV runs behaviour monitoring (keystroke/mouse beacons), so move like a hand: a curved-ish path to a
// random point inside the target, a beat, then the click. Typing goes key by key at human speed.
let mouse = { x: rand(300, 900), y: rand(200, 600) };
async function click(loc) {
  await loc.waitFor({ state: 'visible', timeout: 15_000 });
  await loc.scrollIntoViewIfNeeded();
  const b = await loc.boundingBox();
  const to = { x: b.x + b.width * rand(0.3, 0.7), y: b.y + b.height * rand(0.3, 0.7) };
  const mid = { x: (mouse.x + to.x) / 2 + rand(-80, 80), y: (mouse.y + to.y) / 2 + rand(-60, 60) };
  await page.mouse.move(mid.x, mid.y, { steps: Math.round(rand(8, 16)) });
  await page.mouse.move(to.x, to.y, { steps: Math.round(rand(8, 16)) });
  mouse = to;
  await page.waitForTimeout(rand(80, 250));
  await page.mouse.down(); await page.waitForTimeout(rand(40, 120)); await page.mouse.up();
}
const type = async (loc, text) => { await click(loc); await loc.pressSequentially(text, { delay: rand(90, 180) }); };

const ctx = await chromium.launchPersistentContext(join(HERE, 'profile'), {
  channel: 'chrome',
  headless: false,
  viewport: null,
  args: [
    // Real headed window, parked off-screen so it never pops up while Randy uses the PC.
    '--window-position=-32000,-32000',
    '--window-size=1600,950',
    // Off-screen windows count as occluded on Windows: keep the page "visible" and unthrottled.
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
// BDV's Angular service worker can get stuck serving 504s from a stale cache (seen 2026-09-28): drop it
// every run, like "clear site data" but keeping cookies.
await (await ctx.newCDPSession(page)).send('Storage.clearDataForOrigin', {
  origin: 'https://bdvenlinea.banvenez.com', storageTypes: 'service_workers,cache_storage',
});
const shot = async (name) => DEBUG && page.screenshot({ path: join(DBG, `${name}.png`) }).catch(() => {});

/** Visible movement rows of the open dialog, as text per column. */
const readRows = () => page.locator('mat-dialog-container mat-row').evaluateAll((rows) => rows.map((r) => {
  const c = (k) => r.querySelector(`.mat-column-${k}`)?.textContent.replace(/\s+/g, ' ').trim() ?? '';
  return { fecha: c('fecha'), referencia: c('referencia'), descripcion: c('descripcion'), tipo: c('indicadorCargoAbono'), monto: c('importe'), saldo: c('saldo') };
}));

let loggedIn = false;
let rows = [];
let error = null;
let logoutError = null;
try {
  // Not 'networkidle': Windscribe's DNS blocks the page's trackers, which is fine but noisy.
  // BDV sometimes stalls serving its own assets. Nothing is typed yet, so reloading is safe (unlike the login itself).
  for (let i = 1; ; i++) {
    try {
      await page.goto('https://bdvenlinea.banvenez.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.locator('input:visible').first().waitFor({ timeout: 30_000 });
      break;
    } catch (e) {
      if (i === 3) throw new Error(`la página de BDV no cargó (3 intentos): ${String(e?.message ?? e).split('\n')[0]}`);
      await page.waitForTimeout(rand(20_000, 40_000));
    }
  }
  await pause(1500, 3000);
  await shot('1-home');

  await type(page.locator('input:visible').first(), BDV_USER);
  await pause();
  await click(page.getByRole('button', { name: /^\s*entrar\s*$/i }));

  const pass = page.locator('input[type=password]:visible');
  await pass.waitFor({ timeout: 20_000 });
  await pause();
  await type(pass, BDV_PASS);
  await pause();
  await click(page.getByRole('button', { name: /continuar/i }));

  await page.waitForURL(/posicionconsolidada/, { timeout: 30_000 });
  loggedIn = true;
  await pause(2000, 4000);
  await shot('2-posicion');

  // Movements icon ("subject") in the checking-account row.
  const row = page.locator('tr').filter({ hasText: /CUENTA CORRIENTE/i }).first();
  await click(row.locator('mat-icon', { hasText: 'subject' }));
  await page.locator('mat-dialog-container mat-row').first().waitFor({ timeout: 20_000 });
  await pause(1500, 3000);

  // Biggest page size the paginator offers, then walk the pages.
  await click(page.locator('mat-dialog-container mat-select[aria-label="Registros por página"]'));
  await pause(400, 900);
  await click(page.locator('mat-option').last());
  await pause(1200, 2500);
  for (let i = 0; i < 20; i++) {
    rows.push(...await readRows());
    const next = page.locator('mat-dialog-container .mat-paginator-navigation-next');
    if (!(await next.count()) || (await next.isDisabled())) break;
    await click(next);
    await pause(900, 2000);
  }
  await shot('3-movimientos');
  if (!rows.length) throw new Error('la tabla de movimientos salió vacía');
} catch (e) {
  await shot('error');
  if (DEBUG) writeFileSync(join(DBG, 'error.html'), await page.content().catch(() => ''));
  error = String(e?.message ?? e).split('\n')[0];
  // Shown when a session is still open (ours left behind, or Randy logged in right now): wait, don't push.
  if (/sesi[oó]n activa/i.test(await page.locator('body').innerText().catch(() => '')))
    error = 'BDV dice que ya hay una sesión activa (¿estabas conectado tú, o quedó una abierta?)';
} finally {
  if (loggedIn) {
    // Leave like a person: close the dialog, hit "Salir", confirm if asked.
    try {
      const back = page.locator('mat-dialog-container button[mat-dialog-close]').first(); // "Regresar" (aria-label "Close dialog")
      if (await back.isVisible()) { await click(back); await pause(); }
      await page.locator('mat-dialog-container').waitFor({ state: 'detached', timeout: 10_000 });
      await click(page.locator('button[aria-label="Salir"]:visible').first());
      await pause(800, 1500);
      const yes = page.getByRole('button', { name: /^\s*(s[ií]|aceptar|confirmar)\s*$/i }).first();
      if (await yes.isVisible()) await click(yes);
      await page.waitForURL((u) => !/\/main\//.test(u.pathname), { timeout: 15_000 });
      await shot('4-salir');
    } catch (e) {
      await shot('logout-error');
      if (DEBUG) writeFileSync(join(DBG, 'logout.html'), await page.content().catch(() => ''));
      logoutError = `no pude cerrar sesión: ${String(e?.message ?? e).split('\n')[0]}`;
    }
  }
  await ctx.close();
}

const seen = new Set();
rows = rows.filter((r) => !seen.has(r.referencia) && seen.add(r.referencia));
if (DEBUG) writeFileSync(join(DBG, 'rows.json'), JSON.stringify(rows, null, 2));
// A failed logout still delivers the rows, but reports it so the tray pauses (a session may be left open).
let api = null;
if (!DRY) {
  api = await post(error ? { error } : { rows }).catch((e) => ({ apiError: String(e.message) }));
  if (logoutError) await post({ error: logoutError }).catch(() => {});
}
console.log(JSON.stringify({ ok: !error && !logoutError, error: error ?? logoutError, rows: rows.length, api, debug: DEBUG ? DBG : undefined }));
process.exitCode = error || logoutError || api?.apiError ? 1 : 0;

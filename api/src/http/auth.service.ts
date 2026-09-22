import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../db/prisma.service';

export const SESSION_COOKIE = 'plata_session';
export const SESSION_DAYS = 30;

/** https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app */
export function validateInitData(initData: string, botToken: string, allowedId: string, now = Date.now()): boolean {
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash || !botToken || !allowedId) return false;
  p.delete('hash');
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const want = createHmac('sha256', secret).update(check).digest();
  const got = Buffer.from(hash, 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return false;
  if (now / 1000 - Number(p.get('auth_date')) > 86400) return false;
  try {
    return String(JSON.parse(p.get('user') ?? '{}').id) === String(allowedId);
  } catch {
    return false;
  }
}

export const readCookie = (header: string | undefined, name: string) =>
  header?.split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];

// web_sessions holds both kinds of token, prefixed: "m:" magic link (10 min), "s:" session.
@Injectable()
export class AuthService {
  constructor(private db: PrismaService) {}

  async createMagicToken(): Promise<string> {
    const token = randomBytes(24).toString('base64url');
    await this.db.webSession.create({ data: { token: `m:${token}`, expiresAt: new Date(Date.now() + 10 * 60_000) } });
    return token;
  }

  /** Burns the magic token, returns a new session token (or null). */
  async redeemMagic(token: string): Promise<string | null> {
    const { count } = await this.db.webSession.deleteMany({ where: { token: `m:${token}`, expiresAt: { gt: new Date() } } });
    if (!count) return null;
    const session = randomBytes(32).toString('base64url');
    await this.db.webSession.create({ data: { token: `s:${session}`, expiresAt: new Date(Date.now() + SESSION_DAYS * 86400_000) } });
    await this.db.webSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    return session;
  }

  async validSession(token: string): Promise<boolean> {
    return !!(await this.db.webSession.findFirst({ where: { token: `s:${token}`, expiresAt: { gt: new Date() } } }));
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const authz = req.headers.authorization;
    const session = readCookie(req.headers.cookie, SESSION_COOKIE);
    const ok = authz?.startsWith('tma ')
      ? validateInitData(authz.slice(4), process.env.TG_TOKEN ?? '', process.env.TG_ALLOWED_ID ?? '')
      : !!session && (await this.auth.validSession(decodeURIComponent(session)));
    if (!ok) throw new UnauthorizedException();
    return true;
  }
}

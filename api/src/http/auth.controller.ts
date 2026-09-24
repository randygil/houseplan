import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Post, Query, Res, UnauthorizedException } from '@nestjs/common';
import { AuthService, SESSION_COOKIE, SESSION_DAYS, checkPassword } from './auth.service';

type Res = { setHeader(k: string, v: string): void; redirect(status: number, url: string): void };

// ponytail: global in-memory limiter (5 fails / 15 min). An attacker can lock you out of the password
// login for 15 min, but Telegram /panel still works. Per-IP if that ever matters.
const fails: number[] = [];
const WINDOW = 15 * 60_000;

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  private setCookie(res: Res, session: string) {
    const secure = process.env.PUBLIC_URL?.startsWith('https') ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
  }

  @Get('magic')
  async magic(@Query('token') token: string | undefined, @Res() res: Res) {
    const session = token ? await this.auth.redeemMagic(token) : null;
    if (session) this.setCookie(res, session);
    res.redirect(302, session ? '/' : '/?auth=expired');
  }

  @Post('login')
  @HttpCode(204)
  async login(@Body() body: { password?: unknown } | undefined, @Res({ passthrough: true }) res: Res) {
    while (fails.length && fails[0] < Date.now() - WINDOW) fails.shift();
    if (fails.length >= 5) throw new HttpException('Demasiados intentos, espera 15 min', HttpStatus.TOO_MANY_REQUESTS);
    if (!checkPassword(body?.password, process.env.WEB_PASSWORD)) {
      fails.push(Date.now());
      throw new UnauthorizedException('Clave incorrecta');
    }
    this.setCookie(res, await this.auth.createSession());
  }
}

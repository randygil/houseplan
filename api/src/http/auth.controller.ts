import { Controller, Get, Query, Res } from '@nestjs/common';
import { AuthService, SESSION_COOKIE, SESSION_DAYS } from './auth.service';

type Res = { setHeader(k: string, v: string): void; redirect(status: number, url: string): void };

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Get('magic')
  async magic(@Query('token') token: string | undefined, @Res() res: Res) {
    const session = token ? await this.auth.redeemMagic(token) : null;
    if (session) {
      const secure = process.env.PUBLIC_URL?.startsWith('https') ? '; Secure' : '';
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
    }
    res.redirect(302, session ? '/' : '/?auth=expired');
  }
}

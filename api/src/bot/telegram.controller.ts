import { Body, Controller, ForbiddenException, Headers, HttpCode, Logger, Post } from '@nestjs/common';
import type { Update } from 'grammy/types';
import { BotService } from './bot.service';

@Controller('telegram')
export class TelegramController {
  private log = new Logger('Telegram');
  constructor(private botSvc: BotService) {}

  @Post()
  @HttpCode(200)
  hook(@Headers('x-telegram-bot-api-secret-token') secret: string | undefined, @Body() update: Update) {
    const want = process.env.TG_WEBHOOK_SECRET;
    if (!this.botSvc.bot || !want || secret !== want) throw new ForbiddenException();
    // Ack right away: LLM calls can outlast Telegram's webhook timeout and it would redeliver.
    this.botSvc.bot.handleUpdate(update).catch((e) => this.log.error(e));
    return { ok: true };
  }
}

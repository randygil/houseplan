import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DbModule } from './db/prisma.service';
import { FxModule } from './fx/fx.module';
import { HttpModule } from './http/http.module';
import { InsightsModule } from './insights/insights.module';
import { LedgerModule } from './ledger/ledger.module';
import { BinanceModule } from './binance/binance.module';
import { AiModule } from './ai/ai.module';
import { BotModule } from './bot/bot.module';

// Each agent adds its module here (ledger, fx, insights, binance, ai, bot, web-api).
@Module({
  imports: [ScheduleModule.forRoot(), DbModule, FxModule, LedgerModule, InsightsModule, HttpModule, BinanceModule, AiModule, BotModule],
})
export class AppModule {}

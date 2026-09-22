import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { BinanceModule } from '../binance/binance.module';
import { HttpModule } from '../http/http.module';
import { InsightsModule } from '../insights/insights.module';
import { LedgerModule } from '../ledger/ledger.module';
import { BotService } from './bot.service';
import { NudgesService } from './nudges.service';
import { TelegramController } from './telegram.controller';

@Module({
  imports: [LedgerModule, InsightsModule, AiModule, HttpModule, BinanceModule],
  controllers: [TelegramController],
  providers: [BotService, NudgesService],
})
export class BotModule {}

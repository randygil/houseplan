import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { BdvController } from '../bdv/bdv.controller';
import { BdvService, BdvTokenGuard } from '../bdv/bdv.service';
import { BinanceModule } from '../binance/binance.module';
import { HttpModule } from '../http/http.module';
import { InsightsModule } from '../insights/insights.module';
import { LedgerModule } from '../ledger/ledger.module';
import { BotService } from './bot.service';
import { NudgesService } from './nudges.service';
import { TelegramController } from './telegram.controller';

@Module({
  imports: [LedgerModule, InsightsModule, AiModule, HttpModule, BinanceModule],
  controllers: [TelegramController, BdvController],
  providers: [BotService, NudgesService, BdvService, BdvTokenGuard],
})
export class BotModule {}

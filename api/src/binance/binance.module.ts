import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { FxModule } from '../fx/fx.module';
import { BinanceClient } from './binance.client';
import { BinanceService } from './binance.service';

@Module({
  imports: [LedgerModule, FxModule],
  providers: [BinanceClient, BinanceService],
  exports: [BinanceService, BinanceClient],
})
export class BinanceModule {}

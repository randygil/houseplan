import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { InsightsService } from './insights.service';

@Module({ imports: [LedgerModule], providers: [InsightsService], exports: [InsightsService] })
export class InsightsModule {}

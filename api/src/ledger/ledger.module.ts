import { Module } from '@nestjs/common';
import { FxModule } from '../fx/fx.module';
import { BagsService } from './bags.service';
import { CategoriesService } from './categories.service';
import { DebtsService } from './debts.service';
import { LedgerService } from './ledger.service';

@Module({
  imports: [FxModule],
  providers: [LedgerService, BagsService, CategoriesService, DebtsService],
  exports: [LedgerService, BagsService, CategoriesService, DebtsService, FxModule],
})
export class LedgerModule {}

import { Module } from '@nestjs/common';
import { FxModule } from '../fx/fx.module';
import { BagsService } from './bags.service';
import { CategoriesService } from './categories.service';
import { DebtsService } from './debts.service';
import { LedgerService } from './ledger.service';
import { PlanService } from './plan.service';

@Module({
  imports: [FxModule],
  providers: [LedgerService, BagsService, CategoriesService, DebtsService, PlanService],
  exports: [LedgerService, BagsService, CategoriesService, DebtsService, PlanService, FxModule],
})
export class LedgerModule {}

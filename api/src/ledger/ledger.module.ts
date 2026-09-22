import { Module } from '@nestjs/common';
import { FxModule } from '../fx/fx.module';
import { BagsService } from './bags.service';
import { CategoriesService } from './categories.service';
import { LedgerService } from './ledger.service';

@Module({
  imports: [FxModule],
  providers: [LedgerService, BagsService, CategoriesService],
  exports: [LedgerService, BagsService, CategoriesService, FxModule],
})
export class LedgerModule {}

import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { InsightsModule } from '../insights/insights.module';
import { LedgerModule } from '../ledger/ledger.module';
import { ApiController } from './api.controller';
import { AuthController } from './auth.controller';
import { AuthGuard, AuthService } from './auth.service';

@Module({
  imports: [LedgerModule, InsightsModule, AiModule],
  controllers: [ApiController, AuthController],
  providers: [AuthService, AuthGuard],
  exports: [AuthService],
})
export class HttpModule {}

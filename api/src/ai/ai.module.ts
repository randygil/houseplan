import { Module } from '@nestjs/common';
import { InsightsModule } from '../insights/insights.module';
import { LedgerModule } from '../ledger/ledger.module';
import { AskService } from './ask.service';
import { EmbeddingsService } from './embeddings.service';
import { IntentService } from './intent.service';
import { LlmService } from './llm.service';
import { TranscribeService } from './transcribe.service';

const services = [LlmService, EmbeddingsService, AskService, TranscribeService, IntentService];

@Module({ imports: [LedgerModule, InsightsModule], providers: services, exports: services })
export class AiModule {}

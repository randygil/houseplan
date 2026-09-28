import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { BdvService, BdvTokenGuard } from './bdv.service';

/** Called by bdv/sync.mjs on Randy's PC: `{ rows, from? }` after a read, `{ error }` when it gave up. */
@Controller('bdv')
@UseGuards(BdvTokenGuard)
export class BdvController {
  constructor(private bdv: BdvService) {}

  @Post('sync') async sync(@Body() b: any) {
    if (b?.error) { await this.bdv.failed(String(b.error)); return { ok: true }; }
    const from = b?.from ? new Date(b.from) : undefined;
    if (from && isNaN(+from)) throw new BadRequestException('from: invalid date');
    return this.bdv.sync(b?.rows, from);
  }
}

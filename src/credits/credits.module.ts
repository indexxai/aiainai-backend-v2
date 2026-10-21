import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CreditAccount, CreditAccountSchema, CreditEntry, CreditEntrySchema } from './credit.schema.js';
import { CreditsService } from './credits.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CreditAccount.name, schema: CreditAccountSchema },
      { name: CreditEntry.name, schema: CreditEntrySchema },
    ]),
  ],
  providers: [CreditsService],
  exports: [CreditsService, MongooseModule],
})
export class CreditsModule {}

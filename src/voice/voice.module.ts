import { Module } from '@nestjs/common';
import { CreditsModule } from '../credits/credits.module.js';
import { ModelsModule } from '../models/models.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { VoiceController } from './voice.controller.js';
import { VoiceService } from './voice.service.js';

@Module({
  imports: [ModelsModule, CreditsModule, WorkspacesModule],
  controllers: [VoiceController],
  providers: [VoiceService],
})
export class VoiceModule {}

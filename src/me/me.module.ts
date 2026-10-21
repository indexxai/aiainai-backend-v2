import { Module } from '@nestjs/common';
import { CreditsModule } from '../credits/credits.module.js';
import { ModelsModule } from '../models/models.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { MeController } from './me.controller.js';

@Module({ imports: [WorkspacesModule, CreditsModule, ModelsModule], controllers: [MeController] })
export class MeModule {}

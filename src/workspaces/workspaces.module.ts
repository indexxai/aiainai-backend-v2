import { Module } from '@nestjs/common';
import { CreditsModule } from '../credits/credits.module.js';
import { WorkspacesService } from './workspaces.service.js';

@Module({ imports: [CreditsModule], providers: [WorkspacesService], exports: [WorkspacesService] })
export class WorkspacesModule {}

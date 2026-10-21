import { Module } from '@nestjs/common';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { SpacesController } from './spaces.controller.js';

@Module({ imports: [WorkspacesModule], controllers: [SpacesController] })
export class SpacesModule {}

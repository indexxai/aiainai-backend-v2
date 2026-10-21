import { Module } from '@nestjs/common';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { ActionsModule } from '../actions/actions.module.js';
import { ActivityController } from './activity.controller.js';
import { ActivityService } from './activity.service.js';

@Module({
  imports: [WorkspacesModule, ActionsModule],
  controllers: [ActivityController],
  providers: [ActivityService],
})
export class ActivityModule {}

import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/auth.decorators.js';
import { ApiErrorResponse } from '../common/api-error.js';
import { parseInput } from '../common/validation.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import { ActivityDto, AllApprovalsDto } from './activity.dto.js';
import { ActivityService } from './activity.service.js';

const query = z
  .object({
    space: z.enum(['all', 'personal', 'business']).default('all'),
    kind: z.enum(['all', 'conversation', 'doc', 'image', 'purchases']).default('all'),
  })
  // Unknown query parameters (cache busters, tracking) are ignored, not refused.
  .strip();

/** Activity and Approvals across both spaces (v2). */
@ApiTags('activity')
@ApiUnauthorizedResponse({ type: ApiErrorResponse })
@Controller()
export class ActivityController {
  constructor(
    private readonly activity: ActivityService,
    private readonly workspaces: WorkspacesService,
  ) {}

  @Get('activity')
  @ApiOperation({ summary: 'What you and Jack did (last 30 days), and what’s coming up' })
  @ApiQuery({ name: 'space', enum: ['all', 'personal', 'business'], required: false })
  @ApiQuery({
    name: 'kind',
    enum: ['all', 'conversation', 'doc', 'image', 'purchases'],
    required: false,
  })
  @ApiOkResponse({ type: ActivityDto })
  async list(@CurrentUser() user: SessionUser, @Query() raw: unknown): Promise<ActivityDto> {
    return this.activity.activity(await this.workspaces.spacesFor(user), parseInput(query, raw));
  }

  @Get('approvals')
  @ApiOperation({ summary: 'What Jack is waiting for your OK on, and what you decided' })
  @ApiOkResponse({ type: AllApprovalsDto })
  async approvals(@CurrentUser() user: SessionUser): Promise<AllApprovalsDto> {
    return this.activity.allApprovals(await this.workspaces.spacesFor(user));
  }
}

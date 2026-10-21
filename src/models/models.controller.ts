import { Controller, Get, Query } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import type { Model } from 'mongoose';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/auth.decorators.js';
import { ApiErrorResponse } from '../common/api-error.js';
import { parseInput } from '../common/validation.js';
import { UserProfile } from '../database/schemas/user-profile.schema.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import { ModelMenuDto } from './models.dto.js';
import { ModelsService } from './models.service.js';

const query = z.object({ kind: z.enum(['text', 'image']).default('text') });

@ApiTags('models')
@Controller('models')
export class ModelsController {
  constructor(
    private readonly models: ModelsService,
    private readonly workspaces: WorkspacesService,
    @InjectModel(UserProfile.name) private readonly profiles: Model<UserProfile>,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Models for the model menu, with plan locks and the person’s default' })
  @ApiQuery({ name: 'kind', enum: ['text', 'image'], required: false })
  @ApiOkResponse({ type: ModelMenuDto })
  @ApiUnauthorizedResponse({ type: ApiErrorResponse })
  async list(@CurrentUser() user: SessionUser, @Query() raw: unknown): Promise<ModelMenuDto> {
    const { kind } = parseInput(query, raw);
    const { billing } = await this.workspaces.forRequest(user);
    const profile = await this.profiles.findOne({ userId: user.id }, { textModel: 1 }).lean();
    return this.models.menu(kind, billing.plan, profile?.textModel ?? 'auto');
  }
}

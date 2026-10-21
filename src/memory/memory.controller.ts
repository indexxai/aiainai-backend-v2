import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBody,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/auth.decorators.js';
import { ApiErrorResponse } from '../common/api-error.js';
import { parseInput } from '../common/validation.js';
import { MEMORY_GROUPS } from '../database/schemas/memory.schema.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import { AddMemoryDto, MemoryDto, MemoryListDto, MemorySettingsDto, UpdateMemoryDto } from './memory.dto.js';
import { MemoryService, type MemoryActor } from './memory.service.js';

const text = z.string().trim().min(1, 'Write what to remember').max(300);
const addInput = z.object({ text, group: z.enum(MEMORY_GROUPS) }).strict();
const updateInput = z.object({ text: text.optional(), group: z.enum(MEMORY_GROUPS).optional() }).strict();
const settingsInput = z.object({ enabled: z.boolean() }).strict();

/** Memory for the current space (header x-aiainai-space). */
@ApiTags('memory')
@ApiUnauthorizedResponse({ type: ApiErrorResponse })
@Controller('memory')
export class MemoryController {
  constructor(
    private readonly memory: MemoryService,
    private readonly workspaces: WorkspacesService,
  ) {}

  private async actor(user: SessionUser): Promise<MemoryActor> {
    const { workspace, billing } = await this.workspaces.forRequest(user);
    return { userId: user.id, workspaceId: workspace._id, plan: billing.plan };
  }

  @Get()
  @ApiOperation({ summary: 'What Jack knows in this space, newest first' })
  @ApiOkResponse({ type: MemoryListDto })
  async list(@CurrentUser() user: SessionUser): Promise<MemoryListDto> {
    return this.memory.list(await this.actor(user));
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Tell Jack something to remember' })
  @ApiBody({ type: AddMemoryDto })
  @ApiOkResponse({ type: MemoryDto })
  async add(@CurrentUser() user: SessionUser, @Body() body: unknown): Promise<MemoryDto> {
    return this.memory.add(await this.actor(user), parseInput(addInput, body ?? {}));
  }

  @Patch('settings')
  @ApiOperation({ summary: 'Let Jack learn new things in this space, or not' })
  @ApiBody({ type: MemorySettingsDto })
  @ApiOkResponse({ type: MemorySettingsDto })
  async settings(@CurrentUser() user: SessionUser, @Body() body: unknown): Promise<MemorySettingsDto> {
    return this.memory.setEnabled(await this.actor(user), parseInput(settingsInput, body ?? {}).enabled);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Change a memory' })
  @ApiBody({ type: UpdateMemoryDto })
  @ApiOkResponse({ type: MemoryDto })
  async update(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<MemoryDto> {
    return this.memory.update(await this.actor(user), id, parseInput(updateInput, body ?? {}));
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Forget a memory (deleted for good)' })
  @ApiNoContentResponse()
  async forget(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<void> {
    await this.memory.forget(await this.actor(user), id);
  }
}

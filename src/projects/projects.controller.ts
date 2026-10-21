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
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import {
  CreateProjectDto,
  ProjectDetailDto,
  ProjectDto,
  ProjectItemDto,
  UpdateProjectDto,
} from './projects.dto.js';
import { ProjectsService, type ProjectActor } from './projects.service.js';

const name = z.string().trim().min(1, 'Give the project a name').max(120);
const instructions = z.string().max(4000);
const createInput = z.object({ name, instructions: instructions.optional() }).strict();
const updateInput = z
  .object({ name: name.optional(), instructions: instructions.optional() })
  .strict()
  .refine((v) => v.name !== undefined || v.instructions !== undefined, { message: 'Nothing to change' });
const itemInput = z.object({ kind: z.enum(['chat', 'doc', 'file']), id: z.string().max(40) }).strict();

/** Projects for the current space (header x-aiainai-space). */
@ApiTags('projects')
@ApiUnauthorizedResponse({ type: ApiErrorResponse })
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly workspaces: WorkspacesService,
  ) {}

  private async actor(user: SessionUser): Promise<ProjectActor> {
    const { workspace } = await this.workspaces.forRequest(user);
    return { userId: user.id, workspaceId: workspace._id };
  }

  @Get()
  @ApiOperation({ summary: 'Projects in this space, most recently used first' })
  @ApiOkResponse({ type: [ProjectDto] })
  async list(@CurrentUser() user: SessionUser): Promise<ProjectDto[]> {
    return this.projects.list(await this.actor(user));
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Start a project' })
  @ApiBody({ type: CreateProjectDto })
  @ApiOkResponse({ type: ProjectDto })
  async create(@CurrentUser() user: SessionUser, @Body() body: unknown): Promise<ProjectDto> {
    return this.projects.create(await this.actor(user), parseInput(createInput, body ?? {}));
  }

  @Get(':id')
  @ApiOperation({ summary: 'A project with its chats, documents and files' })
  @ApiOkResponse({ type: ProjectDetailDto })
  async detail(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<ProjectDetailDto> {
    return this.projects.detail(await this.actor(user), id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename a project or change its instructions' })
  @ApiBody({ type: UpdateProjectDto })
  @ApiOkResponse({ type: ProjectDto })
  async update(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ProjectDto> {
    return this.projects.update(await this.actor(user), id, parseInput(updateInput, body ?? {}));
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a project (its chats, documents and files are kept)' })
  @ApiNoContentResponse()
  async remove(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<void> {
    await this.projects.remove(await this.actor(user), id);
  }

  @Post(':id/items')
  @HttpCode(204)
  @ApiOperation({ summary: 'Add a chat, document or file to the project (moving it from another one)' })
  @ApiBody({ type: ProjectItemDto })
  @ApiNoContentResponse()
  async addItem(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<void> {
    await this.projects.addItem(await this.actor(user), id, parseInput(itemInput, body ?? {}));
  }

  @Post(':id/items/remove')
  @HttpCode(204)
  @ApiOperation({ summary: 'Take a chat, document or file out of the project (it is kept)' })
  @ApiBody({ type: ProjectItemDto })
  @ApiNoContentResponse()
  async removeItem(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<void> {
    await this.projects.removeItem(await this.actor(user), id, parseInput(itemInput, body ?? {}));
  }
}

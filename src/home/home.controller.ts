import { assistantOf } from '../assistant/assistant-name.js';
import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { CurrentUser, type SessionUser } from '../auth/auth.decorators.js';
import { ApiErrorResponse } from '../common/api-error.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import { HomeDto } from './home.dto.js';
import { HomeService } from './home.service.js';

@ApiTags('home')
@ApiUnauthorizedResponse({ type: ApiErrorResponse })
@Controller('home')
export class HomeController {
  constructor(
    private readonly home: HomeService,
    private readonly workspaces: WorkspacesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Jack’s home for the current space: needs you, in progress, suggestions' })
  @ApiOkResponse({ type: HomeDto })
  async get(@CurrentUser() user: SessionUser): Promise<HomeDto> {
    const { workspace, space } = await this.workspaces.forRequest(user);
    return this.home.summary(workspace._id, space, assistantOf(workspace).name);
  }
}

import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { CurrentUser, type SessionUser } from '../auth/auth.decorators.js';
import { ApiErrorResponse } from '../common/api-error.js';
import type { WorkspaceDocument } from '../database/schemas/workspace.schema.js';
import { PROVIDER_NAMES, PROVIDERS } from '../models/models.logic.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import { SpaceBusinessDto, SpacesDto } from './spaces.dto.js';

const businessDto = (ws: WorkspaceDocument): SpaceBusinessDto => ({
  id: ws._id.toHexString(),
  name: ws.name,
  website: ws.business?.website,
  about: ws.business?.about,
  helpWith: ws.business?.helpWith ?? [],
});

/** Personal and Business spaces: which one a request is in. */
@ApiTags('spaces')
@ApiUnauthorizedResponse({ type: ApiErrorResponse })
@Controller('spaces')
export class SpacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  @ApiOperation({ summary: 'The person’s spaces and which one this request is in (header x-aiainai-space)' })
  @ApiOkResponse({ type: SpacesDto })
  async get(@CurrentUser() user: SessionUser): Promise<SpacesDto> {
    const scope = await this.workspaces.forRequest(user);
    const business =
      scope.space === 'business' ? scope.workspace : await this.workspaces.findBusiness(scope.billing._id);
    return {
      active: scope.space,
      personal: { id: scope.billing._id.toHexString(), name: scope.billing.name },
      business: business ? businessDto(business) : null,
      providers: PROVIDERS.map((id) => ({ id, name: PROVIDER_NAMES[id] })),
    };
  }
}

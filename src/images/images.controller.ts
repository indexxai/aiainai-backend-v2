import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPaymentRequiredResponse,
  ApiProduces,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/auth.decorators.js';
import { ApiErrorResponse, AppError } from '../common/api-error.js';
import { parseInput } from '../common/validation.js';
import { IMAGE_STYLES, REFERENCE_USES } from '../database/schemas/image.schema.js';
import { IMAGE_RATIOS } from '../models/providers.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import {
  CreateImagesDto,
  EditImageDto,
  ImageCapabilitiesDto,
  ImageGenerationDto,
  ImageIndexDto,
  ImageListDto,
  ImprovedPromptDto,
  ImprovePromptDto,
  ReferenceDto,
} from './images.dto.js';
import { ImagesService, MAX_REFERENCE_BYTES, type Actor } from './images.service.js';

const createInput = z
  .object({
    prompt: z.string().trim().min(3, 'Describe the image').max(1000),
    model: z.string().trim().min(1).max(64).optional(),
    ratio: z.enum(IMAGE_RATIOS),
    count: z.union([z.literal(1), z.literal(2), z.literal(4)]),
    hd: z.boolean().optional(),
    style: z.enum(IMAGE_STYLES).optional(),
    negative: z.string().max(300).optional(),
    reference: z
      .object({ id: z.string().regex(/^[a-f0-9]{24}$/), use: z.enum(REFERENCE_USES) })
      .strict()
      .optional(),
  })
  .strict();
const indexInput = z.object({ index: z.number().int().min(0).max(3) }).strict();
const editInput = z
  .object({
    index: z.number().int().min(0).max(3),
    prompt: z.string().trim().min(2, 'Say what should be there').max(1000),
    mask: z.string().min(20).max(1_000_000),
    model: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
const improveInput = z
  .object({
    prompt: z.string().trim().min(2, 'Write a few words first').max(1000),
    style: z.enum(IMAGE_STYLES).optional(),
  })
  .strict();
const refQuery = z.object({ name: z.string().max(200).optional() });
const listQuery = z.object({ cursor: z.string().max(40).optional(), q: z.string().max(100).optional() });
const fileQuery = z.object({
  variant: z.enum(['full', 'thumb']).optional(),
  format: z.enum(['png', 'jpg', 'webp']).optional(),
  download: z.enum(['1', 'true']).optional(),
});

@ApiTags('images')
@ApiUnauthorizedResponse({ type: ApiErrorResponse })
@Controller('images')
export class ImagesController {
  constructor(
    private readonly images: ImagesService,
    private readonly workspaces: WorkspacesService,
  ) {}

  private async actor(user: SessionUser): Promise<Actor> {
    const { workspace: ws, billing, space } = await this.workspaces.forRequest(user);
    return {
      userId: user.id,
      workspaceId: ws._id,
      plan: billing.plan,
      space,
    };
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Generate 1–4 images',
    description:
      'Returns once credits are reserved (status "generating"); poll GET /api/images/:id for the images. ' +
      'Each finished image is charged at the model price; failed or cancelled ones are free.',
  })
  @ApiBody({ type: CreateImagesDto })
  @ApiOkResponse({ type: ImageGenerationDto })
  @ApiPaymentRequiredResponse({ type: ApiErrorResponse, description: 'Not enough credits' })
  async create(@CurrentUser() user: SessionUser, @Body() body: unknown): Promise<ImageGenerationDto> {
    return this.images.create(await this.actor(user), parseInput(createInput, body));
  }

  @Get('capabilities')
  @ApiOperation({
    summary: 'Which extra tools (reference, edit, variations, upscale, remove background) can be used',
  })
  @ApiOkResponse({ type: ImageCapabilitiesDto })
  async capabilities(@CurrentUser() user: SessionUser): Promise<ImageCapabilitiesDto> {
    return this.images.capabilities(await this.actor(user));
  }

  @Post('improve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Improve prompt: a fuller description to use instead (free)' })
  @ApiBody({ type: ImprovePromptDto })
  @ApiOkResponse({ type: ImprovedPromptDto })
  async improve(@CurrentUser() user: SessionUser, @Body() body: unknown): Promise<ImprovedPromptDto> {
    return this.images.improvePrompt(await this.actor(user), parseInput(improveInput, body));
  }

  @Post('references')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Upload a reference image (raw JPG, PNG or WebP body, up to 20 MB)',
    description:
      'Send the file bytes as the body with its image/* content type. Use the returned id in POST /api/images.',
  })
  @ApiQuery({ name: 'name', required: false, description: 'The file name, shown back to the person' })
  @ApiOkResponse({ type: ReferenceDto })
  async reference(
    @CurrentUser() user: SessionUser,
    @Query() raw: unknown,
    @Req() req: Request,
  ): Promise<ReferenceDto> {
    const name = parseInput(refQuery, raw).name ?? 'reference';
    if (
      !/^image\/(jpeg|png|webp)$/.test(
        String(req.headers['content-type'] ?? '')
          .split(';')[0]!
          .trim(),
      )
    )
      throw new AppError(
        'validation_failed',
        `${name} isn’t an image. Use a JPG, PNG or WebP under 20 MB.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    const bytes = await readBody(req, MAX_REFERENCE_BYTES);
    return this.images.uploadReference(await this.actor(user), bytes, name);
  }

  @Get()
  @ApiOperation({ summary: 'Image batches, newest first; search prompts with `q`' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiOkResponse({ type: ImageListDto })
  async list(@CurrentUser() user: SessionUser, @Query() raw: unknown): Promise<ImageListDto> {
    return this.images.list(await this.actor(user), parseInput(listQuery, raw));
  }

  @Get(':id')
  @ApiOperation({ summary: 'A batch with its images (poll while "generating")' })
  @ApiOkResponse({ type: ImageGenerationDto })
  @ApiNotFoundResponse({ type: ApiErrorResponse })
  async get(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<ImageGenerationDto> {
    return this.images.get(await this.actor(user), id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stop a batch; images not finished yet are not charged' })
  @ApiOkResponse({ type: ImageGenerationDto })
  async cancel(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<ImageGenerationDto> {
    return this.images.cancel(await this.actor(user), id);
  }

  @Post(':id/variations')
  @HttpCode(200)
  @ApiOperation({ summary: 'Four variations of one image (model price × 4)' })
  @ApiBody({ type: ImageIndexDto })
  @ApiOkResponse({ type: ImageGenerationDto })
  async variations(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ImageGenerationDto> {
    return this.images.variations(await this.actor(user), id, parseInput(indexInput, body).index);
  }

  @Post(':id/edit')
  @HttpCode(200)
  @ApiOperation({ summary: 'Change part of an image (a new image; the original is kept)' })
  @ApiBody({ type: EditImageDto })
  @ApiOkResponse({ type: ImageGenerationDto })
  async edit(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ImageGenerationDto> {
    const input = parseInput(editInput, body);
    const mask = Buffer.from(input.mask.replace(/^data:image\/png;base64,/, ''), 'base64');
    return this.images.edit(await this.actor(user), id, input.index, { ...input, mask });
  }

  @Post(':id/upscale')
  @HttpCode(200)
  @ApiOperation({ summary: 'A larger version of one image (Pro)' })
  @ApiBody({ type: ImageIndexDto })
  @ApiOkResponse({ type: ImageGenerationDto })
  async upscale(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ImageGenerationDto> {
    return this.images.tool(await this.actor(user), id, parseInput(indexInput, body).index, 'upscale');
  }

  @Post(':id/remove-background')
  @HttpCode(200)
  @ApiOperation({ summary: 'The image with its background removed, as a transparent PNG (Pro)' })
  @ApiBody({ type: ImageIndexDto })
  @ApiOkResponse({ type: ImageGenerationDto })
  async removeBackground(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ImageGenerationDto> {
    return this.images.tool(await this.actor(user), id, parseInput(indexInput, body).index, 'cutout');
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a batch and its files' })
  @ApiNoContentResponse()
  async remove(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<void> {
    await this.images.remove(await this.actor(user), id);
  }

  @Get(':id/files/:index')
  @ApiOperation({ summary: 'An image file: full PNG, a WebP preview, or JPG/WebP for download' })
  @ApiQuery({ name: 'variant', required: false, enum: ['full', 'thumb'] })
  @ApiQuery({ name: 'format', required: false, enum: ['png', 'jpg', 'webp'] })
  @ApiQuery({ name: 'download', required: false })
  @ApiProduces('image/png', 'image/webp', 'image/jpeg')
  @ApiOkResponse({ description: 'Image bytes' })
  async file(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Param('index') index: string,
    @Query() raw: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const q = parseInput(fileQuery, raw);
    const i = Number(index);
    const f = await this.images.file(await this.actor(user), id, Number.isInteger(i) ? i : -1, q);
    res.setHeader('Content-Type', f.contentType);
    res.setHeader('Content-Length', String(f.bytes.length));
    // Files never change once made; only the signed-in owner can fetch them.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (q.download) res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
    res.end(f.bytes);
  }
}

/** Read a raw request body up to `limit` bytes. */
function readBody(req: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new AppError('payload_too_large', 'Use an image under 20 MB.', HttpStatus.PAYLOAD_TOO_LARGE));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

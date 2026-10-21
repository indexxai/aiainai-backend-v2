import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { AppError } from '../common/api-error.js';
import { scoped } from '../database/scoped.js';
import { Chat } from '../database/schemas/chat.schema.js';
import { DocumentRecord } from '../database/schemas/document.schema.js';
import { Project } from '../database/schemas/project.schema.js';
import { Upload } from '../database/schemas/upload.schema.js';
import { toSummary, type ChatLean } from '../chats/chat.summary.js';
import { toDto as fileDto } from '../files/files.service.js';
import type { ProjectDetailDto, ProjectDto } from './projects.dto.js';

type Lean<T> = T & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };
export interface ProjectActor {
  userId: string;
  workspaceId: Types.ObjectId;
}
export type ItemKind = 'chat' | 'doc' | 'file';

/** Most projects in one space. */
export const MAX_PROJECTS = 100;

const notFound = () => new AppError('not_found', 'We can’t find that project.', HttpStatus.NOT_FOUND);
const oid = (id: string, missing = notFound) => {
  if (!Types.ObjectId.isValid(id)) throw missing();
  return new Types.ObjectId(id);
};

/**
 * Projects group chats, documents and files about one thing. Jack reads a project's instructions
 * and files in every chat inside it (see ChatsService.filesContext).
 */
@Injectable()
export class ProjectsService {
  constructor(
    @InjectModel(Project.name) private readonly projects: Model<Project>,
    @InjectModel(Chat.name) private readonly chats: Model<Chat>,
    @InjectModel(DocumentRecord.name) private readonly docs: Model<DocumentRecord>,
    @InjectModel(Upload.name) private readonly uploads: Model<Upload>,
  ) {}

  async list(actor: ProjectActor): Promise<ProjectDto[]> {
    const rows = await this.projects
      .find(scoped<Project>(actor.workspaceId))
      .sort({ updatedAt: -1 })
      .limit(MAX_PROJECTS)
      .lean<Lean<Project>[]>();
    return Promise.all(rows.map((p) => this.toDto(p)));
  }

  async create(actor: ProjectActor, input: { name: string; instructions?: string }): Promise<ProjectDto> {
    if ((await this.projects.countDocuments(scoped<Project>(actor.workspaceId))) >= MAX_PROJECTS)
      throw new AppError(
        'conflict',
        `You can have ${MAX_PROJECTS} projects in a space. Delete one to start another.`,
        HttpStatus.CONFLICT,
      );
    const doc = await this.projects.create({
      workspaceId: actor.workspaceId,
      createdBy: actor.userId,
      name: input.name.trim(),
      instructions: (input.instructions ?? '').trim(),
    });
    return this.toDto(doc.toObject() as unknown as Lean<Project>);
  }

  async detail(actor: ProjectActor, id: string): Promise<ProjectDetailDto> {
    const p = await this.find(actor, id);
    const [chats, docs, files] = await Promise.all([
      this.chats
        .find(scoped<Chat>(actor.workspaceId, { projectId: p._id }))
        .sort({ lastMessageAt: -1 })
        .limit(100)
        .lean<ChatLean[]>(),
      this.docs
        .find(scoped<DocumentRecord>(actor.workspaceId, { projectId: p._id }), {
          title: 1,
          status: 1,
          updatedAt: 1,
        })
        .sort({ updatedAt: -1 })
        .limit(100)
        .lean<Lean<DocumentRecord>[]>(),
      this.uploads
        .find(scoped<Upload>(actor.workspaceId, { projectId: p._id }), { text: 0 })
        .sort({ _id: -1 })
        .limit(100)
        .lean<Lean<Upload>[]>(),
    ]);
    return {
      project: await this.toDto(p),
      chats: chats.map((c) => toSummary(c)),
      docs: docs.map((d) => ({
        id: d._id.toHexString(),
        title: d.title,
        status: d.status,
        updatedAt: new Date(d.updatedAt).toISOString(),
      })),
      files: files.map((f) => fileDto(f)),
    };
  }

  async update(
    actor: ProjectActor,
    id: string,
    input: { name?: string; instructions?: string },
  ): Promise<ProjectDto> {
    const p = await this.find(actor, id);
    const $set: Partial<Project> = {};
    if (input.name !== undefined) $set.name = input.name.trim();
    if (input.instructions !== undefined) $set.instructions = input.instructions.trim();
    const updated = await this.projects
      .findOneAndUpdate({ _id: p._id }, { $set }, { new: true })
      .lean<Lean<Project>>();
    return this.toDto(updated!);
  }

  /** Deletes the project. Its chats, documents and files stay, just no longer grouped. */
  async remove(actor: ProjectActor, id: string): Promise<void> {
    const p = await this.find(actor, id);
    const out = { $set: { projectId: null } };
    await Promise.all([
      this.chats.updateMany({ workspaceId: actor.workspaceId, projectId: p._id }, out),
      this.docs.updateMany({ workspaceId: actor.workspaceId, projectId: p._id }, out),
      this.uploads.updateMany({ workspaceId: actor.workspaceId, projectId: p._id }, out),
    ]);
    await this.projects.updateOne({ _id: p._id }, { $set: { deletedAt: new Date() } });
  }

  /** Put a chat, document or file in this project (moving it from another one). */
  async addItem(actor: ProjectActor, id: string, item: { kind: ItemKind; id: string }): Promise<void> {
    const p = await this.find(actor, id);
    await this.setProject(actor, item, p._id);
    await this.touch(p._id);
  }

  /** Take an item out of this project (it stays in the space). */
  async removeItem(actor: ProjectActor, id: string, item: { kind: ItemKind; id: string }): Promise<void> {
    const p = await this.find(actor, id);
    await this.setProject(actor, item, null, p._id);
    await this.touch(p._id);
  }

  /** The project a new chat goes in (checked to be this space's). */
  async own(actor: ProjectActor, id: string): Promise<Lean<Project>> {
    return this.find(actor, id);
  }

  async touch(id: Types.ObjectId): Promise<void> {
    await this.projects.updateOne({ _id: id }, { $set: { updatedAt: new Date() } });
  }

  private async setProject(
    actor: ProjectActor,
    item: { kind: ItemKind; id: string },
    projectId: Types.ObjectId | null,
    onlyFrom?: Types.ObjectId,
  ): Promise<void> {
    const missing = () =>
      new AppError(
        'not_found',
        `We can’t find that ${item.kind === 'doc' ? 'document' : item.kind}.`,
        HttpStatus.NOT_FOUND,
      );
    const _id = oid(item.id, missing);
    const filter = { _id, ...(onlyFrom && { projectId: onlyFrom }) };
    const update = { $set: { projectId } };
    const res =
      item.kind === 'chat'
        ? await this.chats.updateOne(scoped<Chat>(actor.workspaceId, filter), update)
        : item.kind === 'doc'
          ? await this.docs.updateOne(scoped<DocumentRecord>(actor.workspaceId, filter), update)
          : await this.uploads.updateOne(scoped<Upload>(actor.workspaceId, filter), update);
    if (!res.matchedCount) throw missing();
  }

  private async find(actor: ProjectActor, id: string): Promise<Lean<Project>> {
    const p = await this.projects
      .findOne(scoped<Project>(actor.workspaceId, { _id: oid(id) }))
      .lean<Lean<Project>>();
    if (!p) throw notFound();
    return p;
  }

  private async toDto(p: Lean<Project>): Promise<ProjectDto> {
    const [chatCount, docCount, fileCount] = await Promise.all([
      this.chats.countDocuments(scoped<Chat>(p.workspaceId, { projectId: p._id })),
      this.docs.countDocuments(scoped<DocumentRecord>(p.workspaceId, { projectId: p._id })),
      this.uploads.countDocuments(scoped<Upload>(p.workspaceId, { projectId: p._id })),
    ]);
    return {
      id: p._id.toHexString(),
      name: p.name,
      instructions: p.instructions ?? '',
      chatCount,
      docCount,
      fileCount,
      updatedAt: new Date(p.updatedAt).toISOString(),
    };
  }
}

import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiModel, AiModelSchema } from './schemas/ai-model.schema.js';
import { Chat, ChatSchema, Message, MessageSchema } from './schemas/chat.schema.js';
import { DocVersion, DocVersionSchema } from './schemas/doc-version.schema.js';
import { DocumentRecord, DocumentRecordSchema } from './schemas/document.schema.js';
import { ImageGeneration, ImageGenerationSchema } from './schemas/image.schema.js';
import { Project, ProjectSchema } from './schemas/project.schema.js';
import { UsageEvent, UsageEventSchema } from './schemas/usage-event.schema.js';
import { UserProfile, UserProfileSchema } from './schemas/user-profile.schema.js';
import { Workspace, WorkspaceSchema } from './schemas/workspace.schema.js';
import { Memory, MemorySchema } from './schemas/memory.schema.js';
import { Connection, ConnectionSchema } from './schemas/connection.schema.js';
import { Receipt, ReceiptSchema, Wallet, WalletSchema } from './schemas/wallet.schema.js';
import { JackAction, JackActionSchema } from './schemas/jack-action.schema.js';
import { BrowserTask, BrowserTaskSchema } from './schemas/browser-task.schema.js';
import { Upload, UploadSchema } from './schemas/upload.schema.js';
import { Payment, PaymentSchema } from './schemas/payment.schema.js';

/** Registers every collection once so any feature module can inject its model. */
export const MODELS = [
  { name: Workspace.name, schema: WorkspaceSchema },
  { name: Memory.name, schema: MemorySchema },
  { name: Connection.name, schema: ConnectionSchema },
  { name: Wallet.name, schema: WalletSchema },
  { name: Receipt.name, schema: ReceiptSchema },
  { name: JackAction.name, schema: JackActionSchema },
  { name: BrowserTask.name, schema: BrowserTaskSchema },
  { name: Upload.name, schema: UploadSchema },
  { name: UserProfile.name, schema: UserProfileSchema },
  { name: Project.name, schema: ProjectSchema },
  { name: Chat.name, schema: ChatSchema },
  { name: Message.name, schema: MessageSchema },
  { name: DocumentRecord.name, schema: DocumentRecordSchema },
  { name: DocVersion.name, schema: DocVersionSchema },
  { name: ImageGeneration.name, schema: ImageGenerationSchema },
  { name: AiModel.name, schema: AiModelSchema },
  { name: UsageEvent.name, schema: UsageEventSchema },
  { name: Payment.name, schema: PaymentSchema },
];

@Global()
@Module({
  imports: [MongooseModule.forFeature(MODELS)],
  exports: [MongooseModule],
})
export class DataModule {}

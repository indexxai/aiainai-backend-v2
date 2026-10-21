import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';

export const IS_PUBLIC = 'aiainai:public';
/** Endpoints anyone can call without signing in (health checks, public share links). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
}

export interface AuthedRequest {
  user: SessionUser;
  session: { id: string; expiresAt: Date };
}

/** The signed-in user, e.g. `me(@CurrentUser() user: SessionUser)`. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): SessionUser => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().user;
});

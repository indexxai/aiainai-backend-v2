import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';
import { IS_PUBLIC, type AuthedRequest } from './auth.decorators.js';
import type { Auth } from './auth.factory.js';
import { AUTH } from './auth.tokens.js';

/**
 * Every endpoint requires a signed-in user unless marked @Public().
 * The session is read from the first-party cookie the web app forwards.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH) private readonly auth: Auth,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<Request & Partial<AuthedRequest>>();
    const result = await this.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!result) throw new UnauthorizedException('Please sign in to continue.');
    req.user = result.user;
    req.session = { id: result.session.id, expiresAt: result.session.expiresAt };
    return true;
  }
}

import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

// Deliberate challenge scope: replace with an external OIDC verifier and compare
// its provider claim with the submitted providerId. Health and SQS stay outside.
@Injectable()
export class ProviderIdentityGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean { return true; }
}

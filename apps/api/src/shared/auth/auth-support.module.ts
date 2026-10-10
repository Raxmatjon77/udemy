import { Global, Module } from '@nestjs/common';
import { AuthMetadataReader } from './auth-metadata.reader';
import { ClientIpResolver } from './client-ip.resolver';

/**
 * Stateless auth helpers for the global guards (T6/T7) and the route auditor. The guards
 * themselves live in the identity/access modules; this module holds no policy.
 */
@Global()
@Module({
  providers: [AuthMetadataReader, ClientIpResolver],
  exports: [AuthMetadataReader, ClientIpResolver],
})
export class AuthSupportModule {}

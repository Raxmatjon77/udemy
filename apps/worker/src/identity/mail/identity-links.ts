import { Injectable } from '@nestjs/common';
import { WorkerConfigService } from '../../shared/config';
import { tokenLink } from './identity-mail.templates';

/** Links into the student app (where the account pages live, design §10). */
@Injectable()
export class IdentityLinks {
  constructor(private readonly config: WorkerConfigService) {}

  private get origin(): string {
    return this.config.get('STUDENT_APP_ORIGIN');
  }

  verifyEmail(token: string): string {
    return tokenLink(this.origin, '/verify-email', token);
  }

  resetPassword(token: string): string {
    return tokenLink(this.origin, '/reset-password', token);
  }

  login(): string {
    return `${this.origin}/login`;
  }

  forgotPassword(): string {
    return `${this.origin}/forgot-password`;
  }
}

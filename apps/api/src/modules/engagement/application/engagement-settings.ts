import { AUTO_HIDE_REPORT_THRESHOLD } from '@udemy/contracts';

/** Engagement configuration (validated env; design §14 "Configuration"). */
export class EngagementSettings {
  constructor(
    /** `ENGAGEMENT_AUTO_HIDE_REPORTS`: distinct OPEN reports that hide a subject (D13). */
    readonly autoHideReports: number = AUTO_HIDE_REPORT_THRESHOLD,
  ) {
    if (!Number.isInteger(autoHideReports) || autoHideReports < 1) {
      throw new RangeError('ENGAGEMENT_AUTO_HIDE_REPORTS must be a positive integer');
    }
  }
}

import { Module } from '@nestjs/common';
import { CertificatePdfPublisher } from './certificates/certificate-pdf.publisher';
import { CertificateIssuerHandler } from './handlers/certificate-issuer.handler';
import {
  CertificateReinstaterHandler,
  CertificateRevokerHandler,
} from './handlers/certificate-revoker.handlers';
import { LearningMaintenanceJob } from './maintenance/learning-maintenance.job';
import { CertificateSourceReader } from './persistence/certificate-source.reader';

/**
 * Worker side of learning (Phase 5 design D7, §5 worker table, P5-T15): the certificate issuer
 * (`CourseCompleted` -> certificate + PDF + `CertificateIssued`), the certificate revoker
 * (`EnrollmentRevoked` / regrant) and the hourly `LearningMaintenanceJob` (`_08`). Uses the
 * global DatabaseModule, StorageModule (`ObjectStorage`, media bucket), WorkerConfigModule and
 * ScheduleModule. Nothing is exported.
 */
@Module({
  providers: [
    CertificateSourceReader,
    CertificatePdfPublisher,
    CertificateIssuerHandler,
    CertificateRevokerHandler,
    CertificateReinstaterHandler,
    LearningMaintenanceJob,
  ],
})
export class LearningModule {}

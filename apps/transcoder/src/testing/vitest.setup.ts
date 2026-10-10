import { Logger } from '@nestjs/common';

// Keep test output readable: Nest's default console logger is silenced for every test file.
Logger.overrideLogger(false);

import { Logger } from '@nestjs/common';

// Keep test output readable: Nest's default console logger is silenced for every test file.
// (Tests that care about logging can spy on Logger.prototype methods.)
Logger.overrideLogger(false);

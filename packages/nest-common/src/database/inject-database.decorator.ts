import { Inject } from '@nestjs/common';
import { DATABASE } from './database.constants';

/** Shorthand for `@Inject(DATABASE)`. */
export const InjectDatabase = (): PropertyDecorator & ParameterDecorator => Inject(DATABASE);

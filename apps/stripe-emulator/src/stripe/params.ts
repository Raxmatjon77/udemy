import type { FormObject, FormValue } from '../http/form';
import { isFormObject } from '../http/form';
import { invalidRequest, missingParameter, unknownParameter } from '../http/stripe-error';

/** Stripe metadata limits: 50 keys, 40-char keys, 500-char values. */
const METADATA_MAX_KEYS = 50;
const METADATA_MAX_KEY_LENGTH = 40;
const METADATA_MAX_VALUE_LENGTH = 500;

function childPath(parent: string, key: string): string {
  return parent === '' ? key : `${parent}[${key}]`;
}

function describe(value: FormValue): string {
  return typeof value === 'string' ? 'a string' : 'a hash';
}

/**
 * Reads a decoded form object field by field and remembers what it consumed, so `finish()` can
 * reject every parameter the emulator does not implement exactly as Stripe rejects unknown ones
 * (`parameter_unknown`, with the full bracketed `param` path).
 */
export class ParamReader {
  private readonly consumed = new Set<string>();

  constructor(
    private readonly source: FormObject,
    readonly path = '',
  ) {}

  private take(name: string): FormValue | undefined {
    this.consumed.add(name);
    return this.source[name];
  }

  has(name: string): boolean {
    return this.source[name] !== undefined;
  }

  string(name: string, options: { required: true; maxLength?: number }): string;
  string(name: string, options?: { required?: false; maxLength?: number }): string | undefined;
  string(
    name: string,
    options: { required?: boolean; maxLength?: number } = {},
  ): string | undefined {
    const param = childPath(this.path, name);
    const value = this.take(name);
    if (value === undefined) {
      if (options.required === true) throw missingParameter(param);
      return undefined;
    }
    if (typeof value !== 'string') {
      throw invalidRequest(
        `Invalid string: ${param} must be a string, got ${describe(value)}.`,
        undefined,
        param,
      );
    }
    if (value === '') {
      throw invalidRequest(
        `You passed an empty string for '${param}'. We assume empty values are an attempt to ` +
          "unset a parameter; however '" +
          param +
          "' cannot be unset.",
        'parameter_invalid_empty',
        param,
      );
    }
    if (options.maxLength !== undefined && value.length > options.maxLength) {
      throw invalidRequest(
        `Invalid string: ${param} must be at most ${options.maxLength} characters.`,
        'string_length_exceeds_maximum',
        param,
      );
    }
    return value;
  }

  integer(name: string, options: { required: true; min?: number; max?: number }): number;
  integer(
    name: string,
    options?: { required?: false; min?: number; max?: number },
  ): number | undefined;
  integer(
    name: string,
    options: { required?: boolean; min?: number; max?: number } = {},
  ): number | undefined {
    const param = childPath(this.path, name);
    const raw =
      options.required === true ? this.string(name, { required: true }) : this.string(name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(value)) {
      throw invalidRequest(`Invalid integer: ${raw}`, 'parameter_invalid_integer', param);
    }
    if (options.min !== undefined && value < options.min) {
      throw invalidRequest(
        `Invalid ${param}: must be greater than or equal to ${options.min}.`,
        'parameter_invalid_integer',
        param,
      );
    }
    if (options.max !== undefined && value > options.max) {
      throw invalidRequest(
        `Invalid ${param}: must be less than or equal to ${options.max}.`,
        'parameter_invalid_integer',
        param,
      );
    }
    return value;
  }

  enumValue<T extends string>(name: string, values: readonly T[], required: true): T;
  enumValue<T extends string>(name: string, values: readonly T[], required?: false): T | undefined;
  enumValue<T extends string>(name: string, values: readonly T[], required = false): T | undefined {
    const param = childPath(this.path, name);
    const raw = required ? this.string(name, { required: true }) : this.string(name);
    if (raw === undefined) return undefined;
    if (!(values as readonly string[]).includes(raw)) {
      throw invalidRequest(
        `Invalid ${param}: must be one of ${values.join(', ')}`,
        undefined,
        param,
      );
    }
    return raw as T;
  }

  /** An absolute http(s) URL (Stripe: `url_invalid`). */
  url(name: string, required: boolean): string | undefined {
    const param = childPath(this.path, name);
    const raw = required
      ? this.string(name, { required: true, maxLength: 5000 })
      : this.string(name, { maxLength: 5000 });
    if (raw === undefined) return undefined;
    let parsed: URL | undefined;
    try {
      // `{CHECKOUT_SESSION_ID}` is legal in success_url; the braces must not break parsing.
      parsed = new URL(raw.replace('{CHECKOUT_SESSION_ID}', 'cs_placeholder'));
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      throw invalidRequest('Not a valid URL', 'url_invalid', param);
    }
    return raw;
  }

  object(name: string, required: true): ParamReader;
  object(name: string, required?: false): ParamReader | undefined;
  object(name: string, required = false): ParamReader | undefined {
    const param = childPath(this.path, name);
    const value = this.take(name);
    if (value === undefined) {
      if (required) throw missingParameter(param);
      return undefined;
    }
    if (!isFormObject(value)) {
      throw invalidRequest(`Invalid hash: ${param} must be a hash.`, undefined, param);
    }
    return new ParamReader(value, param);
  }

  /** A list encoded as `name[0]…name[n-1]`. */
  list(name: string, required: boolean): FormValue[] | undefined {
    const param = childPath(this.path, name);
    const value = this.take(name);
    if (value === undefined) {
      if (required) throw missingParameter(param);
      return undefined;
    }
    if (!isFormObject(value)) {
      throw invalidRequest(`Invalid array: ${param} must be an array.`, undefined, param);
    }
    const keys = Object.keys(value);
    const items: FormValue[] = [];
    for (let index = 0; index < keys.length; index += 1) {
      const item = value[String(index)];
      if (item === undefined) {
        throw invalidRequest(`Invalid array: ${param} must be an array.`, undefined, param);
      }
      items.push(item);
    }
    return items;
  }

  objectList(name: string, required: boolean): ParamReader[] | undefined {
    const items = this.list(name, required);
    if (items === undefined) return undefined;
    return items.map((item, index) => {
      const param = `${childPath(this.path, name)}[${index}]`;
      if (!isFormObject(item)) {
        throw invalidRequest(`Invalid hash: ${param} must be a hash.`, undefined, param);
      }
      return new ParamReader(item, param);
    });
  }

  stringList(name: string, required: boolean): string[] | undefined {
    const items = this.list(name, required);
    if (items === undefined) return undefined;
    return items.map((item, index) => {
      if (typeof item !== 'string' || item === '') {
        const param = `${childPath(this.path, name)}[${index}]`;
        throw invalidRequest(
          `Invalid string: ${param} must be a non-empty string.`,
          undefined,
          param,
        );
      }
      return item;
    });
  }

  /** Stripe metadata: string values; an empty value means "unset" and is dropped. */
  metadata(name: string): Record<string, string> | undefined {
    const param = childPath(this.path, name);
    const value = this.take(name);
    if (value === undefined) return undefined;
    if (value === '') return {};
    if (!isFormObject(value)) {
      throw invalidRequest(`Invalid hash: ${param} must be a hash.`, undefined, param);
    }
    const result: Record<string, string> = {};
    const entries = Object.entries(value);
    if (entries.length > METADATA_MAX_KEYS) {
      throw invalidRequest(
        `Invalid ${param}: metadata can have at most ${METADATA_MAX_KEYS} keys.`,
        undefined,
        param,
      );
    }
    for (const [key, entry] of entries) {
      const entryParam = `${param}[${key}]`;
      if (key.length > METADATA_MAX_KEY_LENGTH) {
        throw invalidRequest(
          `Invalid ${param}: keys must be at most ${METADATA_MAX_KEY_LENGTH} characters.`,
          undefined,
          entryParam,
        );
      }
      if (typeof entry !== 'string') {
        throw invalidRequest(
          `Invalid ${entryParam}: metadata values must be strings.`,
          undefined,
          entryParam,
        );
      }
      if (entry.length > METADATA_MAX_VALUE_LENGTH) {
        throw invalidRequest(
          `Invalid ${entryParam}: values must be at most ${METADATA_MAX_VALUE_LENGTH} characters.`,
          undefined,
          entryParam,
        );
      }
      if (entry !== '') result[key] = entry;
    }
    return result;
  }

  /** Rejects the first parameter nobody read (in request order). */
  finish(): void {
    for (const key of Object.keys(this.source)) {
      if (!this.consumed.has(key)) throw unknownParameter(childPath(this.path, key));
    }
  }
}

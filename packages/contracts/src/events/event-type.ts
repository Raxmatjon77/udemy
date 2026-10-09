/**
 * Event versioning on the wire.
 *
 * The outbox row has one `type` column, which Debezium copies into the `eventType`
 * Kafka header. There is no separate version column or header, so the version is
 * encoded in the type itself: `<Name>.v<version>`, e.g. `SystemPing.v1`.
 * Inside the code we always work with the split form `{ type, version }`.
 */
const QUALIFIED_TYPE = /^(?<type>.+)\.v(?<version>[1-9]\d*)$/;

export interface ParsedEventType {
  type: string;
  version: number;
}

export function qualifyEventType(type: string, version: number): string {
  return `${type}.v${version}`;
}

/**
 * Splits `SystemPing.v2` into `{ type: 'SystemPing', version: 2 }`.
 * A type without a `.vN` suffix is treated as version 1, so events written
 * before versioning existed (or by hand) are still accepted.
 */
export function parseEventType(qualifiedType: string): ParsedEventType {
  const match = QUALIFIED_TYPE.exec(qualifiedType);
  if (!match?.groups?.type || !match.groups.version) {
    return { type: qualifiedType, version: 1 };
  }
  return { type: match.groups.type, version: Number(match.groups.version) };
}

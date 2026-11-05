import { randomBytes } from 'node:crypto';

/** RFC 9562 UUIDv7, usable in both the Bun CLI and the Node plugin host.
 * These identifiers require uniqueness and a millisecond time prefix, not
 * monotonic ordering within the same millisecond (74 bits stay random).
 */
export function randomUUIDv7(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

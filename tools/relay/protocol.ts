/** Limits shared by the local Node relay and the Cloudflare Durable Object relay. */
export const DEFAULT_ROOM_CAPACITY = 8;
export const MAX_FRAME_BYTES = 1024;
export const MAX_MEMBER_DATA_CHARS = 200;
export const MAX_SETTINGS_CHARS = 1500;
export const MAX_START_CHARS = 4000;
export const MAX_TEXT_BYTES = 8192;
export const RELAY_HEADER_BYTES = 2;

export interface RelayControlMessage {
  readonly type?: string;
  readonly data?: unknown;
}

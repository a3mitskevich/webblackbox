type Base64Uint8Array = Uint8Array & { toBase64?: () => string };
type Base64Uint8ArrayConstructor = typeof Uint8Array & {
  fromBase64?: (value: string) => Uint8Array;
};

/** `String.fromCharCode` takes its bytes as arguments: stay well below the engine's limit. */
const ENCODE_CHUNK_BYTES = 0x8000;

/** Standard base64 (with padding). Uses the native encoder where the engine has one. */
export function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as Base64Uint8Array).toBase64;

  if (typeof native === "function") {
    return native.call(bytes);
  }

  let binary = "";

  for (let offset = 0; offset < bytes.byteLength; offset += ENCODE_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + ENCODE_CHUNK_BYTES));
  }

  return btoa(binary);
}

/** Decodes standard base64; throws on malformed input. */
export function base64ToBytes(value: string): Uint8Array {
  const native = (Uint8Array as Base64Uint8ArrayConstructor).fromBase64;

  if (typeof native === "function") {
    return native(value);
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

/** Byte length a padded base64 string decodes to, without decoding it. */
export function base64DecodedLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

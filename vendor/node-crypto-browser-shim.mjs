import { Buffer } from "buffer";

export const webcrypto = globalThis.crypto;

function unsupported(name) {
  return () => {
    throw new Error(`node:crypto.${name} is not available in the browser bundle`);
  };
}

export const createHash = unsupported("createHash");
export const createPrivateKey = unsupported("createPrivateKey");
export const createPublicKey = unsupported("createPublicKey");
export const diffieHellman = unsupported("diffieHellman");

export function timingSafeEqual(left, right) {
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

export function randomBytes(size) {
  const out = new Uint8Array(size);
  globalThis.crypto.getRandomValues(out);
  return Buffer.from(out);
}

export function randomFill(buffer, callback) {
  globalThis.crypto.getRandomValues(buffer);
  if (typeof callback === "function") {
    callback(null, buffer);
  }
  return buffer;
}

export function randomInt(min, max, callback) {
  if (max === undefined) {
    max = min;
    min = 0;
  }
  const range = max - min;
  const array = new Uint32Array(1);
  globalThis.crypto.getRandomValues(array);
  const value = min + (array[0] % range);
  if (typeof callback === "function") {
    callback(null, value);
  }
  return value;
}

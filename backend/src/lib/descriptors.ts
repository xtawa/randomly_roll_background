import crypto from "node:crypto";

function digestToVector(seed: Buffer): number[] {
  const values: number[] = [];
  let cursor = Buffer.from(seed);

  while (values.length < 128) {
    cursor = crypto.createHash("sha512").update(cursor).digest();
    for (const byte of cursor) {
      values.push(Number(((byte / 255) * 2 - 1).toFixed(6)));
      if (values.length === 128) {
        break;
      }
    }
  }

  return values;
}

export function buildDescriptor(seed: Buffer | string): number[] {
  const source = typeof seed === "string" ? Buffer.from(seed) : seed;
  return digestToVector(crypto.createHash("sha256").update(source).digest());
}

import crypto from "node:crypto";

export function generateCode(length = 6): string {
  const digits = "0123456789";
  let output = "";
  const randomBytes = crypto.randomBytes(length);

  for (let index = 0; index < length; index += 1) {
    output += digits[randomBytes[index] % digits.length];
  }

  return output;
}

export function generateToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

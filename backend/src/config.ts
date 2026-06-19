import "dotenv/config";
import path from "node:path";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().default("file:./prisma/dev.db"),
  JWT_SECRET: z.string().min(12).default("change-this-in-production"),
  CORS_ORIGINS: z.string().default("http://localhost:5173,http://127.0.0.1:5173,https://roll.underflo.ink"),
  DEFAULT_ADMIN_EMAIL: z.string().email().default("admin@example.com"),
  DEFAULT_ADMIN_PASSWORD: z.string().min(8).default("ChangeMe123!"),
  STORAGE_DIR: z.string().default("./storage"),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  TURNSTILE_SITE_KEY: z.string().trim().default(""),
  TURNSTILE_SECRET_KEY: z.string().trim().default(""),
  REGISTRATION_LIMIT_PER_IP: z.coerce.number().int().positive().default(2)
});

const parsed = schema.parse(process.env);

export const config = {
  ...parsed,
  storageDir: path.resolve(process.cwd(), parsed.STORAGE_DIR),
  corsOrigins: parsed.CORS_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean),
  turnstile: {
    siteKey: parsed.TURNSTILE_SITE_KEY,
    secretKey: parsed.TURNSTILE_SECRET_KEY,
    enabled: Boolean(parsed.TURNSTILE_SITE_KEY && parsed.TURNSTILE_SECRET_KEY)
  }
};

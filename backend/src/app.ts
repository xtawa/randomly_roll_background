import fs from "node:fs/promises";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { HttpError } from "./lib/http-error.js";
import { authPlugin } from "./plugins/auth.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerClientRoutes } from "./routes/client.js";
import { registerGroupRoutes } from "./routes/groups.js";

export async function buildApp() {
  await fs.mkdir(config.storageDir, { recursive: true });

  const app = Fastify({
    logger: true
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || config.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin not allowed"), false);
    }
  });

  await app.register(multipart, {
    attachFieldsToBody: false,
    limits: {
      fileSize: 10 * 1024 * 1024,
      files: 10
    }
  });

  await app.register(authPlugin);

  app.get("/healthz", async () => ({
    ok: true,
    time: new Date().toISOString()
  }));

  await registerAuthRoutes(app);
  await registerGroupRoutes(app);
  await registerAdminRoutes(app);
  await registerClientRoutes(app);

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof HttpError) {
      reply.code(error.statusCode).send({
        code: error.code,
        message: error.message
      });
      return;
    }

    if (typeof error === "object" && error !== null && "issues" in error) {
      reply.code(400).send({
        code: "VALIDATION_ERROR",
        message: "Request validation failed.",
        details: (error as { issues: unknown }).issues
      });
      return;
    }

    app.log.error(error);
    reply.code(500).send({
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected server error occurred."
    });
  });

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });

  return app;
}

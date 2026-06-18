import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";

type JwtPayload = {
  userId: string;
  email: string;
  role: string;
};

export const authPlugin = fp(async (app) => {
  await app.register(fastifyJwt, {
    secret: config.JWT_SECRET
  });

  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const payload = await request.jwtVerify<JwtPayload>();
      request.authUser = payload;
    } catch {
      reply.code(401).send({
        code: "AUTH_INVALID_TOKEN",
        message: "A valid bearer token is required."
      });
    }
  });

  app.decorate("requireRole", (roles: string[]) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      await app.authenticate(request, reply);
      if (reply.sent) {
        return;
      }

      if (!request.authUser || !roles.includes(request.authUser.role)) {
        reply.code(403).send({
          code: "AUTH_FORBIDDEN",
          message: "The current account does not have permission for this action."
        });
      }
    };
  });
});

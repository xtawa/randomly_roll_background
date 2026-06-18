import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    authUser?: {
      userId: string;
      email: string;
      role: string;
    };
  }

  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void>;
    requireRole: (roles: string[]) => (request: FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void>;
  }
}

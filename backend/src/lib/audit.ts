import type { PrismaClient } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { toJson } from "./json.js";

type AuditInput = {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
};

export async function writeAuditLog(prisma: PrismaClient, request: FastifyRequest | null, input: AuditInput) {
  await prisma.auditLog.create({
    data: {
      actorUserId: request?.authUser?.userId,
      actorEmail: request?.authUser?.email,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      requestId: request?.id ?? null,
      beforeJson: input.before === undefined ? null : toJson(input.before),
      afterJson: input.after === undefined ? null : toJson(input.after),
      metadataJson: input.metadata === undefined ? null : toJson(input.metadata)
    }
  });
}

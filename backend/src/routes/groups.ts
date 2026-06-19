import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { writeAuditLog } from "../lib/audit.js";
import { HttpError } from "../lib/http-error.js";

const groupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional().default("")
});

const groupAssignmentSchema = groupSchema.extend({
  memberIds: z.array(z.string().trim().min(1)).default([]),
  deviceCodes: z.array(z.string().trim().min(1)).default([])
});

export async function registerGroupRoutes(app: FastifyInstance) {
  const adminGuard = { preHandler: app.requireRole(["admin"]) };

  app.get("/api/admin/groups", adminGuard, async () => {
    const [groups, users, devices] = await Promise.all([
      prisma.accountGroup.findMany({
        orderBy: { name: "asc" },
        include: {
          members: {
            orderBy: { email: "asc" },
            select: { id: true, email: true, role: true }
          },
          devices: {
            orderBy: { deviceCode: "asc" },
            include: {
              pairings: {
                where: { isActive: true },
                orderBy: { pairedAt: "desc" },
                take: 1
              }
            }
          }
        }
      }),
      prisma.user.findMany({
        where: { role: { not: "admin" } },
        orderBy: { email: "asc" },
        select: { id: true, email: true, role: true, groupId: true }
      }),
      prisma.device.findMany({
        orderBy: { deviceCode: "asc" },
        include: {
          pairings: {
            where: { isActive: true },
            orderBy: { pairedAt: "desc" },
            take: 1
          }
        }
      })
    ]);

    const faceCounts = await prisma.faceProfile.groupBy({
      by: ["ownerUserId"],
      where: { ownerUserId: { not: null }, isActive: true },
      _count: { _all: true }
    });
    const countByOwner = new Map(faceCounts.map((item) => [item.ownerUserId, item._count._all]));

    return {
      items: groups.map((group) => ({
        id: group.id,
        name: group.name,
        description: group.description || "",
        members: group.members.map((member) => ({
          ...member,
          faceCount: countByOwner.get(member.id) || 0
        })),
        devices: group.devices.map((device) => ({
          deviceCode: device.deviceCode,
          classroom: device.pairings[0]?.classroom ?? null
        })),
        updatedAt: group.updatedAt.toISOString()
      })),
      users,
      devices: devices.map((device) => ({
        deviceCode: device.deviceCode,
        groupId: device.groupId,
        classroom: device.pairings[0]?.classroom ?? null
      }))
    };
  });

  app.post("/api/admin/groups", adminGuard, async (request, reply) => {
    const body = groupSchema.parse(request.body);
    const existing = await prisma.accountGroup.findUnique({ where: { name: body.name } });
    if (existing) {
      throw new HttpError(409, "GROUP_NAME_EXISTS", "An account group with this name already exists.");
    }

    const group = await prisma.accountGroup.create({
      data: { name: body.name, description: body.description || null }
    });
    await writeAuditLog(prisma, request, {
      action: "create_account_group",
      entityType: "account_group",
      entityId: group.id,
      after: body
    });

    reply.code(201).send({ id: group.id, name: group.name });
  });

  app.put("/api/admin/groups/:id", adminGuard, async (request) => {
    const groupId = z.string().trim().min(1).parse((request.params as { id: string }).id);
    const body = groupAssignmentSchema.parse(request.body);
    const existing = await prisma.accountGroup.findUnique({ where: { id: groupId } });
    if (!existing) {
      throw new HttpError(404, "GROUP_NOT_FOUND", "The requested account group does not exist.");
    }
    const nameConflict = await prisma.accountGroup.findFirst({
      where: { name: body.name, id: { not: groupId } }
    });
    if (nameConflict) {
      throw new HttpError(409, "GROUP_NAME_EXISTS", "An account group with this name already exists.");
    }

    const [memberCount, deviceCount] = await Promise.all([
      prisma.user.count({ where: { id: { in: body.memberIds }, role: { not: "admin" } } }),
      prisma.device.count({ where: { deviceCode: { in: body.deviceCodes } } })
    ]);
    if (memberCount !== new Set(body.memberIds).size) {
      throw new HttpError(400, "GROUP_MEMBERS_INVALID", "One or more selected member accounts are invalid.");
    }
    if (deviceCount !== new Set(body.deviceCodes).size) {
      throw new HttpError(400, "GROUP_DEVICES_INVALID", "One or more selected devices are invalid.");
    }

    await prisma.$transaction([
      prisma.accountGroup.update({
        where: { id: groupId },
        data: { name: body.name, description: body.description || null }
      }),
      prisma.user.updateMany({ where: { groupId }, data: { groupId: null } }),
      prisma.device.updateMany({ where: { groupId }, data: { groupId: null } }),
      prisma.user.updateMany({
        where: { id: { in: body.memberIds }, role: { not: "admin" } },
        data: { groupId }
      }),
      prisma.device.updateMany({
        where: { deviceCode: { in: body.deviceCodes } },
        data: { groupId }
      })
    ]);

    await writeAuditLog(prisma, request, {
      action: "update_account_group",
      entityType: "account_group",
      entityId: groupId,
      before: { name: existing.name, description: existing.description },
      after: body
    });

    return { updated: true, id: groupId };
  });

  app.delete("/api/admin/groups/:id", adminGuard, async (request, reply) => {
    const groupId = z.string().trim().min(1).parse((request.params as { id: string }).id);
    const group = await prisma.accountGroup.findUnique({ where: { id: groupId } });
    if (!group) {
      throw new HttpError(404, "GROUP_NOT_FOUND", "The requested account group does not exist.");
    }

    await prisma.accountGroup.delete({ where: { id: groupId } });
    await writeAuditLog(prisma, request, {
      action: "delete_account_group",
      entityType: "account_group",
      entityId: groupId,
      before: { name: group.name, description: group.description }
    });
    reply.code(204).send();
  });
}

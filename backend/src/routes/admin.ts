import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { writeAuditLog } from "../lib/audit.js";
import { buildDescriptor } from "../lib/descriptors.js";
import { HttpError } from "../lib/http-error.js";
import { parseJson, toJson } from "../lib/json.js";

const faceSchema = z.object({
  personId: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  preferred: z.boolean().default(false),
  ignored: z.boolean().default(false),
  baseWeight: z.coerce.number().int().min(1).max(10).default(1),
  tags: z.array(z.string().trim().min(1)).default([])
});

const faceUpdateSchema = faceSchema.omit({ personId: true }).partial().extend({
  baseWeight: z.coerce.number().int().min(1).max(10).optional(),
  tags: z.array(z.string().trim().min(1)).optional()
});

type UploadedSampleFile = {
  filename: string;
  mimetype: string;
  buffer: Buffer;
};

async function saveUploadedFile(personId: string, file: UploadedSampleFile) {
  const ext = path.extname(file.filename || "");
  const directory = path.join(config.storageDir, "uploads", personId);
  await fs.mkdir(directory, { recursive: true });

  const storedFileName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
  const storedPath = path.join(directory, storedFileName);

  await fs.writeFile(storedPath, file.buffer);

  return {
    storedFileName,
    storedPath
  };
}

async function buildSampleEntries(requestBody: unknown, faceId: string, files: UploadedSampleFile[]) {
  if (files.length > 0) {
    const notes = typeof (requestBody as Record<string, unknown> | undefined)?.notes === "string"
      ? String((requestBody as Record<string, unknown>).notes)
      : "";

    return Promise.all(files.map(async (file) => {
      const saved = await saveUploadedFile(faceId, file);
      return {
        notes,
        originalFileName: file.filename,
        storedFileName: saved.storedFileName,
        mimeType: file.mimetype,
        sizeBytes: file.buffer.byteLength,
        qualityScore: 0.9,
        descriptor: buildDescriptor(file.buffer)
      };
    }));
  }

  const body = z.object({
    notes: z.string().optional().default(""),
    fileNames: z.array(z.string().trim().min(1)).min(1),
    descriptors: z.array(z.array(z.number())).optional()
  }).parse(requestBody);

  return body.fileNames.map((fileName, index) => ({
    notes: body.notes,
    originalFileName: fileName,
    storedFileName: null,
    mimeType: "application/octet-stream",
    sizeBytes: null,
    qualityScore: 0.75,
    descriptor: body.descriptors?.[index] || buildDescriptor(`${faceId}:${fileName}:${index}`)
  }));
}

async function parseMultipartFiles(request: Parameters<FastifyInstance["post"]>[1] extends never ? never : any): Promise<UploadedSampleFile[]> {
  if (!request.isMultipart()) {
    return [];
  }

  const files: UploadedSampleFile[] = [];
  const parts = request.parts();
  for await (const part of parts) {
    if (part.type === "file") {
      files.push({
        filename: part.filename,
        mimetype: part.mimetype,
        buffer: await part.toBuffer()
      });
    } else {
      request.body = {
        ...(typeof request.body === "object" && request.body ? request.body : {}),
        [part.fieldname]: part.value
      };
    }
  }
  return files;
}

async function buildPackagePayload(version: string, groupId: string) {
  const faceProfiles = await prisma.faceProfile.findMany({
    where: {
      isActive: true,
      ownerUser: {
        is: {
          groupMemberships: {
            some: { groupId }
          }
        }
      }
    },
    orderBy: { personId: "asc" },
    include: {
      descriptors: {
        orderBy: { createdAt: "desc" },
        take: 5
      }
    }
  });

  return {
    version,
    publishedAt: new Date().toISOString(),
    thresholdDefault: 0.52,
    people: faceProfiles.map((profile) => ({
      personId: profile.personId,
      displayName: profile.displayName,
      descriptors: profile.descriptors.map((item) => parseJson<number[]>(item.vectorJson, [])),
      preferred: profile.preferred,
      ignored: profile.ignored,
      baseWeight: profile.baseWeight,
      tags: parseJson<string[]>(profile.tagsJson, []),
      updatedAt: profile.updatedAt.toISOString()
    }))
  };
}

export async function registerAdminRoutes(app: FastifyInstance) {
  const memberGuard = { preHandler: app.requireRole(["admin", "editor", "member"]) };
  const adminGuard = { preHandler: app.requireRole(["admin"]) };
  const packageVersionSchema = z.string().trim().optional().transform((value) => value || undefined);

  app.get("/api/admin/faces", memberGuard, async (request) => {
    const isAdmin = request.authUser?.role === "admin";
    const records = await prisma.faceProfile.findMany({
      where: isAdmin ? undefined : { ownerUserId: request.authUser!.userId },
      orderBy: { updatedAt: "desc" },
      include: {
        descriptors: true,
        samples: true,
        ownerUser: {
          select: {
            email: true,
            groupMemberships: {
              include: {
                group: {
                  select: { id: true, name: true }
                }
              }
            }
          }
        }
      }
    });

    return {
      items: records.map((record) => ({
        personId: record.personId,
        displayName: record.displayName,
        preferred: record.preferred,
        ignored: record.ignored,
        baseWeight: record.baseWeight,
        tags: parseJson<string[]>(record.tagsJson, []),
        descriptorCount: record.descriptors.length,
        sampleCount: record.samples.length,
        ownerEmail: record.ownerUser?.email ?? null,
        groupId: record.ownerUser?.groupMemberships[0]?.groupId ?? null,
        groups: (record.ownerUser?.groupMemberships || [])
          .map((membership) => membership.group)
          .sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
        updatedAt: record.updatedAt.toISOString()
      }))
    };
  });

  app.post("/api/admin/faces", memberGuard, async (request, reply) => {
    const body = faceSchema.parse(request.body);
    const existing = await prisma.faceProfile.findUnique({ where: { personId: body.personId } });
    if (existing) {
      throw new HttpError(409, "FACE_PROFILE_EXISTS", "A face profile with this personId already exists.");
    }

    const created = await prisma.faceProfile.create({
      data: {
        personId: body.personId,
        displayName: body.displayName,
        preferred: body.preferred,
        ignored: body.ignored,
        baseWeight: body.baseWeight,
        tagsJson: toJson(body.tags),
        ownerUserId: request.authUser?.role === "admin" ? null : request.authUser!.userId
      }
    });

    await writeAuditLog(prisma, request, {
      action: "create_face_profile",
      entityType: "face_profile",
      entityId: created.personId,
      after: body
    });

    reply.code(201).send({
      personId: created.personId,
      displayName: created.displayName
    });
  });

  app.patch("/api/admin/faces/:id", memberGuard, async (request) => {
    const personId = z.string().trim().min(1).parse((request.params as { id: string }).id);
    const body = faceUpdateSchema.parse(request.body);
    const existing = await prisma.faceProfile.findUnique({ where: { personId } });
    if (!existing) {
      throw new HttpError(404, "FACE_PROFILE_NOT_FOUND", "The requested face profile does not exist.");
    }
    if (request.authUser?.role !== "admin" && existing.ownerUserId !== request.authUser?.userId) {
      throw new HttpError(404, "FACE_PROFILE_NOT_FOUND", "The requested face profile does not exist.");
    }

    const updated = await prisma.faceProfile.update({
      where: { personId },
      data: {
        displayName: body.displayName ?? existing.displayName,
        preferred: body.preferred ?? existing.preferred,
        ignored: body.ignored ?? existing.ignored,
        baseWeight: body.baseWeight ?? existing.baseWeight,
        tagsJson: body.tags ? toJson(body.tags) : existing.tagsJson
      }
    });

    await writeAuditLog(prisma, request, {
      action: "update_face_profile",
      entityType: "face_profile",
      entityId: personId,
      before: {
        displayName: existing.displayName,
        preferred: existing.preferred,
        ignored: existing.ignored,
        baseWeight: existing.baseWeight,
        tags: parseJson<string[]>(existing.tagsJson, [])
      },
      after: {
        displayName: updated.displayName,
        preferred: updated.preferred,
        ignored: updated.ignored,
        baseWeight: updated.baseWeight,
        tags: parseJson<string[]>(updated.tagsJson, [])
      }
    });

    return {
      personId: updated.personId,
      displayName: updated.displayName
    };
  });

  app.delete("/api/admin/faces/:id", memberGuard, async (request, reply) => {
    const personId = z.string().trim().min(1).parse((request.params as { id: string }).id);
    const existing = await prisma.faceProfile.findUnique({
      where: { personId },
      include: {
        descriptors: true,
        samples: true
      }
    });

    if (!existing) {
      throw new HttpError(404, "FACE_PROFILE_NOT_FOUND", "The requested face profile does not exist.");
    }
    if (request.authUser?.role !== "admin" && existing.ownerUserId !== request.authUser?.userId) {
      throw new HttpError(404, "FACE_PROFILE_NOT_FOUND", "The requested face profile does not exist.");
    }

    await prisma.faceProfile.delete({
      where: { personId }
    });

    await fs.rm(path.join(config.storageDir, "uploads", personId), {
      recursive: true,
      force: true
    });

    await writeAuditLog(prisma, request, {
      action: "delete_face_profile",
      entityType: "face_profile",
      entityId: personId,
      before: {
        displayName: existing.displayName,
        preferred: existing.preferred,
        ignored: existing.ignored,
        baseWeight: existing.baseWeight,
        tags: parseJson<string[]>(existing.tagsJson, []),
        descriptorCount: existing.descriptors.length,
        sampleCount: existing.samples.length
      }
    });

    reply.code(204).send();
  });

  app.post("/api/admin/faces/:id/samples", memberGuard, async (request, reply) => {
    const faceId = z.string().trim().min(1).parse((request.params as { id: string }).id);
    const profile = await prisma.faceProfile.findUnique({ where: { personId: faceId } });
    if (!profile) {
      throw new HttpError(404, "FACE_PROFILE_NOT_FOUND", "The requested face profile does not exist.");
    }
    if (request.authUser?.role !== "admin" && profile.ownerUserId !== request.authUser?.userId) {
      throw new HttpError(404, "FACE_PROFILE_NOT_FOUND", "The requested face profile does not exist.");
    }

    const files = await parseMultipartFiles(request);
    const entries = await buildSampleEntries(request.body, faceId, files);

    const created = await prisma.$transaction(async (tx) => {
      const results = [];
      for (const entry of entries) {
        const sample = await tx.faceSample.create({
          data: {
            faceProfileId: profile.id,
            notes: entry.notes,
            originalFileName: entry.originalFileName,
            storedFileName: entry.storedFileName,
            mimeType: entry.mimeType,
            sizeBytes: entry.sizeBytes,
            status: "accepted",
            qualityScore: entry.qualityScore
          }
        });

        const descriptor = await tx.faceDescriptor.create({
          data: {
            faceProfileId: profile.id,
            sampleId: sample.id,
            source: entry.storedFileName ? "upload" : "declared",
            vectorJson: toJson(entry.descriptor)
          }
        });

        results.push({ sample, descriptor });
      }
      return results;
    });

    await writeAuditLog(prisma, request, {
      action: "upload_face_samples",
      entityType: "face_profile",
      entityId: faceId,
      metadata: {
        sampleCount: created.length,
        fileNames: created.map((item) => item.sample.originalFileName)
      }
    });

    reply.code(201).send({
      personId: faceId,
      createdSamples: created.length,
      descriptorCount: created.length
    });
  });

  app.get("/api/admin/devices", memberGuard, async (request) => {
    const currentUser = request.authUser?.role === "admin"
      ? null
      : await prisma.user.findUnique({
        where: { id: request.authUser!.userId },
        select: {
          groupMemberships: {
            select: { groupId: true }
          }
        }
      });
    const groupIds = currentUser?.groupMemberships.map((membership) => membership.groupId) || [];
    const devices = await prisma.device.findMany({
      where: request.authUser?.role === "admin"
        ? undefined
        : groupIds.length > 0
          ? { groupId: { in: groupIds } }
          : { groupId: "__unassigned__" },
      orderBy: { updatedAt: "desc" },
      include: {
        pairings: {
          where: { isActive: true },
          orderBy: { pairedAt: "desc" },
          take: 1
        }
      }
    });

    return {
      items: devices.map((device) => {
        const pairing = device.pairings[0];
        return {
          deviceCode: device.deviceCode,
          lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
          classroom: pairing?.classroom ?? null,
          packageVersion: pairing?.packageVersion ?? null,
          devModeEnabled: pairing?.devModeEnabled ?? false,
          pairedAt: pairing?.pairedAt.toISOString() ?? null
        };
      })
    };
  });

  app.post("/api/admin/devices/pair", adminGuard, async (request) => {
    const body = z.object({
      deviceCode: z.string().trim().min(8),
      classroom: z.string().trim().min(1),
      packageVersion: packageVersionSchema,
      devModeEnabled: z.boolean().default(false)
    }).parse(request.body);

    if (body.packageVersion) {
      const pkg = await prisma.facePackage.findUnique({ where: { version: body.packageVersion } });
      if (!pkg) {
        throw new HttpError(404, "PACKAGE_NOT_FOUND", "The requested package version does not exist.");
      }
    }

    const device = await prisma.device.upsert({
      where: { deviceCode: body.deviceCode },
      update: {},
      create: { deviceCode: body.deviceCode }
    });

    await prisma.devicePairing.updateMany({
      where: { deviceId: device.id, isActive: true },
      data: {
        isActive: false,
        revokedAt: new Date()
      }
    });

    const pairing = await prisma.devicePairing.create({
      data: {
        deviceId: device.id,
        classroom: body.classroom,
        packageVersion: body.packageVersion ?? null,
        devModeEnabled: body.devModeEnabled,
        pairedByUserId: request.authUser?.userId ?? null
      }
    });

    await writeAuditLog(prisma, request, {
      action: "pair_device",
      entityType: "device",
      entityId: body.deviceCode,
      after: {
        classroom: pairing.classroom,
        packageVersion: pairing.packageVersion,
        devModeEnabled: pairing.devModeEnabled
      }
    });

    return {
      paired: true,
      deviceCode: body.deviceCode,
      classroom: pairing.classroom,
      packageVersion: pairing.packageVersion,
      devModeEnabled: pairing.devModeEnabled,
      pairedAt: pairing.pairedAt.toISOString()
    };
  });

  app.patch("/api/admin/devices/:deviceCode/package", adminGuard, async (request) => {
    const deviceCode = z.string().trim().min(1).parse((request.params as { deviceCode: string }).deviceCode);
    const body = z.object({
      packageVersion: packageVersionSchema
    }).parse(request.body);

    if (body.packageVersion) {
      const pkg = await prisma.facePackage.findUnique({ where: { version: body.packageVersion } });
      if (!pkg) {
        throw new HttpError(404, "PACKAGE_NOT_FOUND", "The requested package version does not exist.");
      }
    }

    const device = await prisma.device.findUnique({
      where: { deviceCode },
      include: {
        pairings: {
          where: { isActive: true },
          orderBy: { pairedAt: "desc" },
          take: 1
        }
      }
    });

    if (!device || device.pairings.length === 0) {
      throw new HttpError(404, "DEVICE_NOT_PAIRED", "The requested device is not currently paired.");
    }

    const activePairing = device.pairings[0];
    const updated = await prisma.devicePairing.update({
      where: { id: activePairing.id },
      data: { packageVersion: body.packageVersion ?? null }
    });

    await writeAuditLog(prisma, request, {
      action: "update_device_package",
      entityType: "device",
      entityId: deviceCode,
      before: {
        classroom: activePairing.classroom,
        packageVersion: activePairing.packageVersion,
        devModeEnabled: activePairing.devModeEnabled
      },
      after: {
        classroom: updated.classroom,
        packageVersion: updated.packageVersion,
        devModeEnabled: updated.devModeEnabled
      }
    });

    return {
      updated: true,
      deviceCode,
      classroom: updated.classroom,
      packageVersion: updated.packageVersion,
      devModeEnabled: updated.devModeEnabled,
      pairedAt: updated.pairedAt.toISOString(),
      lastSeenAt: device.lastSeenAt?.toISOString() ?? null
    };
  });

  app.get("/api/admin/packages", adminGuard, async () => {
    const packages = await prisma.facePackage.findMany({
      orderBy: { publishedAt: "desc" },
      include: { packagePeople: true, publishedBy: true, group: true }
    });

    return {
      items: packages.map((pkg) => ({
        version: pkg.version,
        isActive: pkg.isActive,
        notes: pkg.notes,
        peopleCount: pkg.packagePeople.length,
        publishedAt: pkg.publishedAt.toISOString(),
        operator: pkg.publishedBy?.email ?? null,
        groupId: pkg.groupId,
        groupName: pkg.group?.name ?? null
      }))
    };
  });

  app.post("/api/admin/packages/publish", adminGuard, async (request, reply) => {
    const body = z.object({
      version: z.string().trim().min(1),
      notes: z.string().trim().optional().default(""),
      groupId: z.string().trim().min(1)
    }).parse(request.body);

    const group = await prisma.accountGroup.findUnique({ where: { id: body.groupId } });
    if (!group) {
      throw new HttpError(404, "GROUP_NOT_FOUND", "The requested account group does not exist.");
    }

    const existing = await prisma.facePackage.findUnique({ where: { version: body.version } });
    if (existing) {
      throw new HttpError(409, "PUBLISH_CONFLICT", "This package version already exists.");
    }

    const payload = await buildPackagePayload(body.version, body.groupId);

    const created = await prisma.$transaction(async (tx) => {
      await tx.facePackage.updateMany({
        where: { isActive: true, groupId: body.groupId },
        data: { isActive: false }
      });

      const facePackage = await tx.facePackage.create({
        data: {
          version: body.version,
          notes: body.notes,
          payloadJson: toJson(payload),
          isActive: true,
          groupId: body.groupId,
          publishedById: request.authUser?.userId ?? null
        }
      });

      if (payload.people.length > 0) {
        await tx.packagePerson.createMany({
          data: payload.people.map((person) => ({
            facePackageId: facePackage.id,
            personId: person.personId,
            displayName: person.displayName,
            preferred: person.preferred,
            ignored: person.ignored,
            baseWeight: person.baseWeight,
            tagsJson: toJson(person.tags),
            descriptorCount: person.descriptors.length,
            updatedAt: new Date(person.updatedAt)
          }))
        });
      }

      await tx.devicePairing.updateMany({
        where: { isActive: true, device: { groupId: body.groupId } },
        data: { packageVersion: body.version }
      });

      return facePackage;
    });

    await writeAuditLog(prisma, request, {
      action: "publish_package",
      entityType: "face_package",
      entityId: body.version,
      after: {
        version: body.version,
        notes: body.notes,
        groupId: body.groupId,
        groupName: group.name,
        peopleCount: payload.people.length
      }
    });

    reply.code(201).send({
      version: created.version,
      publishedAt: created.publishedAt.toISOString(),
      peopleCount: payload.people.length,
      groupId: body.groupId,
      groupName: group.name,
      downloadUrl: new URL(`/api/client/packages/${encodeURIComponent(created.version)}`, config.PUBLIC_BASE_URL).toString()
    });
  });

  app.post("/api/admin/packages/:version/rollback", adminGuard, async (request) => {
    const version = z.string().trim().min(1).parse((request.params as { version: string }).version);
    const target = await prisma.facePackage.findUnique({ where: { version } });
    if (!target) {
      throw new HttpError(404, "ROLLBACK_TARGET_INVALID", "The requested rollback version does not exist.");
    }

    await prisma.$transaction([
      prisma.facePackage.updateMany({
        where: { isActive: true, groupId: target.groupId },
        data: { isActive: false }
      }),
      prisma.facePackage.update({
        where: { version },
        data: { isActive: true }
      }),
      prisma.devicePairing.updateMany({
        where: { isActive: true, device: { groupId: target.groupId } },
        data: { packageVersion: version }
      })
    ]);

    await writeAuditLog(prisma, request, {
      action: "rollback_package",
      entityType: "face_package",
      entityId: version
    });

    return {
      rolledBackTo: version
    };
  });

  app.get("/api/admin/audit-logs", adminGuard, async () => {
    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 200
    });

    return {
      items: logs.map((log) => ({
        when: log.createdAt.toISOString(),
        actor: log.actorEmail,
        action: log.action,
        entityType: log.entityType,
        entityId: log.entityId,
        requestId: log.requestId,
        before: parseJson(log.beforeJson, null),
        after: parseJson(log.afterJson, null),
        metadata: parseJson(log.metadataJson, null)
      }))
    };
  });
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { HttpError } from "../lib/http-error.js";
import { parseJson } from "../lib/json.js";

export async function registerClientRoutes(app: FastifyInstance) {
  app.post("/api/client/bootstrap", async (request) => {
    const body = z.object({
      deviceCode: z.string().trim().min(8),
      appVersion: z.string().trim().min(1),
      mode: z.enum(["AUTO_SYNC", "LOCAL_ONLY"]),
      localPackageVersion: z.string().trim().optional()
    }).parse(request.body);

    const device = await prisma.device.upsert({
      where: { deviceCode: body.deviceCode },
      update: {
        lastSeenAt: new Date()
      },
      create: {
        deviceCode: body.deviceCode,
        lastSeenAt: new Date()
      },
      include: {
        pairings: {
          where: { isActive: true },
          orderBy: { pairedAt: "desc" },
          take: 1
        }
      }
    });

    const pairing = device.pairings[0];
    if (!pairing) {
      return {
        paired: false,
        latestPackageVersion: null,
        updateAvailable: false,
        downloadUrl: null,
        policy: {
          allowUnknownFaces: true,
          unknownBaseWeight: 1,
          devModeEnabled: false
        },
        serverTime: new Date().toISOString()
      };
    }

    const activePackage = pairing.packageVersion
      ? await prisma.facePackage.findUnique({ where: { version: pairing.packageVersion } })
      : await prisma.facePackage.findFirst({ where: { isActive: true }, orderBy: { publishedAt: "desc" } });

    const latestPackageVersion = activePackage?.version ?? null;

    return {
      paired: true,
      latestPackageVersion,
      updateAvailable: Boolean(latestPackageVersion && latestPackageVersion !== body.localPackageVersion),
      downloadUrl: latestPackageVersion
        ? new URL(`/api/client/packages/${encodeURIComponent(latestPackageVersion)}`, config.PUBLIC_BASE_URL).toString()
        : null,
      policy: {
        allowUnknownFaces: true,
        unknownBaseWeight: 1,
        devModeEnabled: pairing.devModeEnabled
      },
      serverTime: new Date().toISOString()
    };
  });

  app.get("/api/client/packages/:version", async (request) => {
    const version = z.string().trim().min(1).parse((request.params as { version: string }).version);
    const facePackage = await prisma.facePackage.findUnique({ where: { version } });
    if (!facePackage) {
      throw new HttpError(404, "PACKAGE_NOT_FOUND", "The requested package version was not found.");
    }

    return parseJson(facePackage.payloadJson, null);
  });
}

import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { writeAuditLog } from "../lib/audit.js";
import { HttpError } from "../lib/http-error.js";
import { generateCode, generateToken } from "../lib/random.js";

const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "qq.com",
  "foxmail.com",
  "163.com",
  "126.com",
  "yeah.net",
  "yahoo.com",
  "yahoo.co.jp",
  "icloud.com",
  "me.com",
  "mac.com",
  "139.com"
]);

const emailSchema = z.string().trim().email().transform((value) => value.toLowerCase());
const credentialsSchema = z.object({
  email: emailSchema,
  password: z.string().min(8)
});

const passwordSchema = z.string().min(8).max(128);
const registrationSchema = credentialsSchema.extend({
  email: emailSchema.refine(
    (value) => PUBLIC_EMAIL_DOMAINS.has(value.split("@").at(-1) || ""),
    "Registration requires a supported public email provider."
  ),
  turnstileToken: z.string().trim().min(1).max(2048)
});

type TurnstileVerificationPayload = {
  success: boolean;
  hostname?: string;
  "error-codes"?: string[];
};

function normalizeClientIp(value: string | null | undefined) {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return "";
  }

  if (rawValue === "::1") {
    return "127.0.0.1";
  }

  if (rawValue.startsWith("::ffff:")) {
    return rawValue.slice(7);
  }

  return rawValue.toLowerCase();
}

function pickForwardedIp(value: string | string[] | undefined) {
  const joined = Array.isArray(value) ? value[0] : value;
  return String(joined || "")
    .split(",")
    .map((item) => item.trim())
    .find(Boolean) || "";
}

function getClientIp(request: FastifyRequest) {
  return normalizeClientIp(
    pickForwardedIp(request.headers["cf-connecting-ip"])
    || pickForwardedIp(request.headers["x-forwarded-for"])
    || pickForwardedIp(request.headers["x-real-ip"])
    || request.ip
  );
}

async function verifyTurnstileToken(token: string, clientIp: string, request: FastifyRequest) {
  if (!config.turnstile.enabled) {
    throw new HttpError(503, "AUTH_CAPTCHA_NOT_CONFIGURED", "Cloudflare Turnstile is not configured on the server.");
  }

  let payload: TurnstileVerificationPayload;

  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        secret: config.turnstile.secretKey,
        response: token,
        remoteip: clientIp
      })
    });

    if (!response.ok) {
      throw new Error(`Turnstile responded with ${response.status}`);
    }

    payload = (await response.json()) as TurnstileVerificationPayload;
  } catch (error) {
    request.log.error({ err: error }, "Turnstile verification request failed.");
    throw new HttpError(502, "AUTH_CAPTCHA_UPSTREAM_FAILED", "Human verification is temporarily unavailable.");
  }

  if (payload.success) {
    return;
  }

  const errorCodes = payload["error-codes"] || [];
  request.log.warn(
    {
      errorCodes,
      hostname: payload.hostname || null
    },
    "Turnstile verification rejected the registration attempt."
  );

  if (errorCodes.includes("missing-input-secret") || errorCodes.includes("invalid-input-secret")) {
    throw new HttpError(503, "AUTH_CAPTCHA_NOT_CONFIGURED", "Cloudflare Turnstile is not configured on the server.");
  }

  throw new HttpError(400, "AUTH_CAPTCHA_INVALID", "Human verification failed. Please try again.");
}

export async function registerAuthRoutes(app: FastifyInstance) {
  app.get("/api/auth/register-config", async () => {
    return {
      captchaEnabled: config.turnstile.enabled,
      turnstileSiteKey: config.turnstile.siteKey || null,
      registrationLimitPerIp: config.REGISTRATION_LIMIT_PER_IP
    };
  });

  app.get("/api/auth/me", { preHandler: app.authenticate }, async (request) => {
    const user = await prisma.user.findUnique({
      where: { id: request.authUser!.userId },
      select: {
        id: true,
        email: true,
        role: true,
        groupMemberships: {
          include: {
            group: {
              select: { id: true, name: true }
            }
          }
        },
        emailVerified: true,
        createdAt: true,
        updatedAt: true
      }
    });

    if (!user) {
      throw new HttpError(404, "AUTH_USER_NOT_FOUND", "The current account no longer exists.");
    }

    const groups = user.groupMemberships
      .map((membership) => membership.group)
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));

    return {
      userId: user.id,
      email: user.email,
      role: user.role,
      group: groups[0] ?? null,
      groups,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString()
    };
  });

  app.post("/api/auth/register", async (request, reply) => {
    const body = registrationSchema.parse(request.body);
    const clientIp = getClientIp(request);

    if (!clientIp) {
      throw new HttpError(400, "AUTH_IP_UNAVAILABLE", "Unable to determine the client IP for registration.");
    }

    await verifyTurnstileToken(body.turnstileToken, clientIp, request);

    const passwordHash = await bcrypt.hash(body.password, 10);
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    const user = await prisma.$transaction(async (tx) => {
      const existingUser = await tx.user.findUnique({ where: { email: body.email } });
      if (existingUser) {
        throw new HttpError(409, "AUTH_EMAIL_EXISTS", "An account with this email already exists.");
      }

      const registrationsFromIp = await tx.user.count({
        where: { registrationIp: clientIp }
      });

      if (registrationsFromIp >= config.REGISTRATION_LIMIT_PER_IP) {
        throw new HttpError(
          429,
          "AUTH_IP_REGISTRATION_LIMIT_REACHED",
          `This IP address has already registered ${config.REGISTRATION_LIMIT_PER_IP} accounts.`
        );
      }

      return tx.user.create({
        data: {
          email: body.email,
          passwordHash,
          registrationIp: clientIp,
          role: "member",
          emailVerifications: {
            create: {
              email: body.email,
              code,
              expiresAt
            }
          }
        }
      });
    });

    await writeAuditLog(prisma, request, {
      action: "register",
      entityType: "user",
      entityId: user.id,
      after: { email: user.email, role: user.role },
      metadata: {
        registrationIp: clientIp
      }
    });

    reply.code(201).send({
      userId: user.id,
      email: user.email,
      role: user.role,
      emailVerified: false,
      verificationCode: code,
      verificationExpiresAt: expiresAt.toISOString()
    });
  });

  app.post("/api/auth/verify-email", async (request) => {
    const body = z.object({
      email: z.string().email(),
      code: z.string().min(4).max(12)
    }).parse(request.body);

    const user = await prisma.user.findUnique({
      where: { email: body.email },
      include: {
        emailVerifications: {
          where: { verifiedAt: null },
          orderBy: { createdAt: "desc" },
          take: 1
        }
      }
    });

    if (!user || user.emailVerifications.length === 0) {
      throw new HttpError(404, "AUTH_VERIFICATION_NOT_FOUND", "No pending email verification was found.");
    }

    const verification = user.emailVerifications[0];
    if (verification.code !== body.code || verification.expiresAt.getTime() < Date.now()) {
      throw new HttpError(400, "AUTH_INVALID_VERIFICATION_CODE", "The verification code is invalid or expired.");
    }

    await prisma.$transaction([
      prisma.emailVerification.update({
        where: { id: verification.id },
        data: { verifiedAt: new Date() }
      }),
      prisma.user.update({
        where: { id: user.id },
        data: {
          emailVerified: true,
          emailVerifiedAt: new Date()
        }
      })
    ]);

    await writeAuditLog(prisma, request, {
      action: "verify_email",
      entityType: "user",
      entityId: user.id,
      after: { email: user.email, emailVerified: true }
    });

    return {
      verified: true,
      email: user.email
    };
  });

  app.post("/api/auth/login", async (request) => {
    const body = credentialsSchema.parse(request.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });

    if (!user) {
      throw new HttpError(401, "AUTH_INVALID_CREDENTIALS", "The provided email or password is incorrect.");
    }

    const passwordMatches = await bcrypt.compare(body.password, user.passwordHash);
    if (!passwordMatches) {
      throw new HttpError(401, "AUTH_INVALID_CREDENTIALS", "The provided email or password is incorrect.");
    }

    if (!user.emailVerified) {
      throw new HttpError(403, "AUTH_EMAIL_NOT_VERIFIED", "This account exists but the email has not been verified.");
    }

    const token = await request.server.jwt.sign({
      userId: user.id,
      email: user.email,
      role: user.role
    });

    await writeAuditLog(prisma, request, {
      action: "login",
      entityType: "user",
      entityId: user.id
    });

    return {
      token,
      user: {
        userId: user.id,
        email: user.email,
        role: user.role
      }
    };
  });

  app.post("/api/auth/forgot-password", async (request) => {
    const body = z.object({
      email: z.string().email()
    }).parse(request.body);

    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user) {
      return {
        accepted: true
      };
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    await prisma.passwordReset.create({
      data: {
        email: body.email,
        token,
        expiresAt,
        userId: user.id
      }
    });

    await writeAuditLog(prisma, request, {
      action: "forgot_password",
      entityType: "user",
      entityId: user.id
    });

    return {
      accepted: true,
      resetToken: token,
      resetTokenExpiresAt: expiresAt.toISOString()
    };
  });

  app.post("/api/auth/reset-password", async (request) => {
    const body = z.object({
      token: z.string().min(16),
      password: passwordSchema
    }).parse(request.body);

    const reset = await prisma.passwordReset.findFirst({
      where: { token: body.token },
      include: { user: true }
    });

    if (!reset || reset.usedAt || reset.expiresAt.getTime() < Date.now()) {
      throw new HttpError(400, "AUTH_INVALID_RESET_TOKEN", "The password reset token is invalid or expired.");
    }

    const passwordHash = await bcrypt.hash(body.password, 10);
    await prisma.$transaction([
      prisma.user.update({
        where: { id: reset.userId },
        data: { passwordHash }
      }),
      prisma.passwordReset.update({
        where: { id: reset.id },
        data: { usedAt: new Date() }
      })
    ]);

    await writeAuditLog(prisma, request, {
      action: "reset_password",
      entityType: "user",
      entityId: reset.userId
    });

    return { reset: true };
  });

  app.post("/api/auth/change-password", { preHandler: app.authenticate }, async (request) => {
    const body = z.object({
      currentPassword: z.string().min(1),
      newPassword: passwordSchema
    }).parse(request.body);

    if (body.currentPassword === body.newPassword) {
      throw new HttpError(400, "AUTH_PASSWORD_UNCHANGED", "The new password must be different from the current password.");
    }

    const user = await prisma.user.findUnique({ where: { id: request.authUser!.userId } });
    if (!user || !(await bcrypt.compare(body.currentPassword, user.passwordHash))) {
      throw new HttpError(401, "AUTH_INVALID_CURRENT_PASSWORD", "The current password is incorrect.");
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(body.newPassword, 10) }
    });

    await writeAuditLog(prisma, request, {
      action: "change_password",
      entityType: "user",
      entityId: user.id
    });

    return { changed: true };
  });
}

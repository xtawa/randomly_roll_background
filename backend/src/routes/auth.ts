import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { writeAuditLog } from "../lib/audit.js";
import { HttpError } from "../lib/http-error.js";
import { generateCode, generateToken } from "../lib/random.js";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

const passwordSchema = z.string().min(8).max(128);

export async function registerAuthRoutes(app: FastifyInstance) {
  app.get("/api/auth/me", { preHandler: app.authenticate }, async (request) => {
    const user = await prisma.user.findUnique({
      where: { id: request.authUser!.userId },
      select: {
        id: true,
        email: true,
        role: true,
        emailVerified: true,
        createdAt: true,
        updatedAt: true
      }
    });

    if (!user) {
      throw new HttpError(404, "AUTH_USER_NOT_FOUND", "The current account no longer exists.");
    }

    return {
      userId: user.id,
      email: user.email,
      role: user.role,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString()
    };
  });

  app.post("/api/auth/register", async (request, reply) => {
    const body = credentialsSchema.parse(request.body);
    const existingUser = await prisma.user.findUnique({ where: { email: body.email } });

    if (existingUser) {
      throw new HttpError(409, "AUTH_EMAIL_EXISTS", "An account with this email already exists.");
    }

    const passwordHash = await bcrypt.hash(body.password, 10);
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    const user = await prisma.user.create({
      data: {
        email: body.email,
        passwordHash,
        role: "editor",
        emailVerifications: {
          create: {
            email: body.email,
            code,
            expiresAt
          }
        }
      }
    });

    await writeAuditLog(prisma, request, {
      action: "register",
      entityType: "user",
      entityId: user.id,
      after: { email: user.email, role: user.role }
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

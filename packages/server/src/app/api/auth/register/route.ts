import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { auditLog } from '@/lib/audit';
import { assignRegistrationCredits } from '@/lib/services/referral-service';
import { billingLogger } from '@/lib/logger';
import { checkRateLimit } from '@/lib/rate-limit';
import { z } from 'zod';

const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  referralCode: z.string().trim().min(1).max(32).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const rateLimited = await checkRateLimit(request, 'auth');
    if (rateLimited) return rateLimited;

    const body = await request.json();

    // Validate input
    const result = registerSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error.errors[0].message },
        { status: 400 }
      );
    }

    const { email, password, referralCode } = result.data;

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return NextResponse.json(
        { success: false, error: 'User with this email already exists' },
        { status: 400 }
      );
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Auto-assign ADMIN role if email matches ADMIN_EMAIL env var
    const adminEmail = process.env.ADMIN_EMAIL;
    const role = adminEmail && email.toLowerCase() === adminEmail.toLowerCase()
      ? 'ADMIN' as const
      : 'USER' as const;

    // Create user
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        role,
      },
    });

    await auditLog({
      userId: user.id,
      action: 'auth.register',
      details: { email: user.email },
    });

    // Assign registration credits (+ referral bonus if applicable)
    // Non-fatal: user is already committed; credits can be backfilled if this fails
    try {
      await assignRegistrationCredits(user.id, referralCode ?? null);
    } catch (creditError) {
      billingLogger.error({ err: creditError, userId: user.id }, 'Failed to assign registration credits');
    }

    return NextResponse.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
      },
    });
  } catch (error) {
    billingLogger.error({ err: error }, 'Registration error');
    return NextResponse.json(
      { success: false, error: 'Failed to create account' },
      { status: 500 }
    );
  }
}

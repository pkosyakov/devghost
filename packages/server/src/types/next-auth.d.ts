import 'next-auth';
import type { UserRole } from '@prisma/client';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      email: string;
      role: UserRole;
    };
    githubAccessToken?: string;
  }

  interface User {
    id: string;
    email: string;
    role?: UserRole;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string;
    email: string;
    role: UserRole;
    roleRefreshedAt?: number;
    githubAccessToken?: string;
  }
}

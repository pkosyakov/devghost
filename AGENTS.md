# Repository Guidelines

## Project Structure & Module Organization
This repository is a `pnpm` workspace monorepo.
- `packages/server`: main Next.js 16 web app (`src/app`, `src/components`, `src/lib`, `prisma`).
- `packages/shared`: shared TypeScript constants, types, and utility logic used by server/mobile.
- `packages/mobile`: Expo React Native app (`src/App.tsx`, `src/screens`, `src/services`).
- `packages/modal`: Python worker for serverless analysis pipeline.
- `packages/ios`: Swift app plus Swift packages (`Core`, `Features`, `SharedUI`).
- `docs`: architecture notes, plans, and reviews. Keep implementation docs here, not in source folders.

## Build, Test, and Development Commands
- `pnpm install`: install all workspace dependencies (Node 20+ required).
- `pnpm dev`: run the web app locally (`@devghost/server`).
- `pnpm build`: build all workspaces that define a `build` script.
- `pnpm lint`: run workspace lint/type checks.
- `pnpm test`: run workspace tests.
- `pnpm --filter @devghost/server test:run`: run server tests once (CI-style).
- `pnpm db:push`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm db:studio`: Prisma DB workflow for `packages/server`.
- `pnpm --filter @devghost/mobile start` (or `ios`/`android`): run Expo mobile app.

## Coding Style & Naming Conventions
- TypeScript is strict; avoid `any` and prefer explicit return types for exported functions.
- Follow existing style: 2-space indentation, semicolons, single quotes, trailing commas where appropriate.
- Use path aliases in server code: `@/*` for local server imports, `@devghost/shared` for shared code.
- React component files use kebab-case (for example, `ghost-kpi-cards.tsx`); component symbols use `PascalCase`.
- Keep API `route.ts` handlers thin; move reusable business logic into `packages/server/src/lib/services`.

## Testing Guidelines
- Test framework: Vitest (`packages/server`, `packages/shared`).
- Test file pattern: `src/**/*.test.ts`; colocate tests in `__tests__` folders or near the module.
- Prefer fast unit tests for utilities/services and targeted route tests for API endpoints.
- Run `pnpm test` before opening a PR; for server-only changes, run `pnpm --filter @devghost/server test:run`.

## Commit & Pull Request Guidelines
- Use Conventional Commits as seen in history: `feat:`, `fix:`, `docs:`, `chore:`, with optional scope (`fix(ios): ...`).
- Keep commit titles imperative and specific.
- PRs should include: summary, linked issue/plan, test evidence (commands run), and screenshots for UI changes.
- Call out schema/env changes explicitly (Prisma migrations, new env vars, webhook keys).

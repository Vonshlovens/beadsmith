# pnpm installs packages (pnpm-lock.yaml, pnpm-workspace.yaml), Vite+ builds,
# Node runs the server (@sveltejs/adapter-node). Versions match package.json
# `packageManager`, `.node-version`, and CI.

# Build stage: install every dependency and build the SvelteKit app.
FROM node:24.22.1-bookworm-slim AS build
RUN npm install --global pnpm@12.15.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

# Production dependencies only. The adapter-node server imports `dependencies`
# from node_modules at start; everything else is bundled into build/.
FROM node:24.22.1-bookworm-slim AS deps
RUN npm install --global pnpm@12.15.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Runtime: Node, the built server (server.js wraps build/handler.js) and
# production node_modules. No pnpm, no registry access at start. Dolt is not in
# this image.
FROM node:24.22.1-bookworm-slim
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/server.js ./server.js
# `node scripts/accounts.ts` recovers a lost admin password (README, Accounts).
# Node runs the script from source, so carry it and the few files it imports;
# if its imports change, change this list (CI's image-smoke runs it offline).
COPY --from=build /app/scripts/accounts.ts ./scripts/accounts.ts
COPY --from=build /app/src/lib/server/auth/recovery.ts /app/src/lib/server/auth/password-policy.ts /app/src/lib/server/auth/roles.ts ./src/lib/server/auth/
COPY --from=build /app/src/lib/server/state/dir.ts ./src/lib/server/state/dir.ts
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4321 BODY_SIZE_LIMIT=64K
EXPOSE 4321
# A 0.0.0.0 bind requires accounts (BETTER_AUTH_SECRET_FILE). compose.yaml publishes loopback only,
# or switches to host networking with HOST=127.0.0.1. Dolt stays a separate
# server; pass its password through BEADS_DOLT_PASSWORD_FILE.
CMD ["node", "server.js"]

# syntax=docker/dockerfile:1
#
# Two deployable processes from one source tree: the Next.js web process and
# the Node worker. They are separate images so they can hold separate
# credentials -- the worker is the only process that needs a signing key, and
# the web process is the only one reachable from the internet.
#
# The base image is pinned by digest. A floating tag would let a rebuilt
# release differ from the one that was verified.
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS base
ENV NODE_ENV=production
WORKDIR /srv/trialoom

# NODE_ENV=production makes npm omit devDependencies, which the build needs.
FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci --include=dev

FROM dependencies AS build
COPY . .
RUN npm run build

# The worker runs the TypeScript sources directly under Node's own type
# stripping, so it needs real node_modules rather than a traced bundle.
FROM base AS runtime-modules
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The web process. Next's standalone output carries only the modules its own
# trace proved reachable.
FROM base AS app
COPY --from=build --chown=node:node /srv/trialoom/.next/standalone ./
COPY --from=build --chown=node:node /srv/trialoom/.next/static ./.next/static
COPY --from=build --chown=node:node /srv/trialoom/public ./public
USER node
ENV PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
# /api/ready is the deployment gate: it answers 503 until the schema is
# migrated, so an orchestrator can hold traffic instead of serving errors.
CMD ["node", "server.js"]

# The worker process. Not reachable from the internet; it claims leased jobs
# from the same database.
FROM base AS worker
COPY --from=runtime-modules --chown=node:node /srv/trialoom/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json next-env.d.ts ./
COPY --chown=node:node src ./src
COPY --chown=node:node workers ./workers
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node runners ./runners
COPY --chown=node:node db ./db
USER node
# Migrations run as an explicit step before a release, not on worker start:
#   docker run --rm trialoom-worker node scripts/migrate.ts
CMD ["node", "workers/main.ts"]

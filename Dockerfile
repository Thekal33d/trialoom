# syntax=docker/dockerfile:1
#
# The web process. The worker is built from Dockerfile.worker, as a separate
# image, so the two can hold separate credentials: the worker is the only
# process that needs a signing key, and this is the only one reachable from the
# internet.
#
# The two are separate FILES rather than two targets of one file because
# Railway builds the last stage of a Dockerfile and offers no way to select a
# target; a service points at the file it wants with RAILWAY_DOCKERFILE_PATH.
#
# The base image is pinned by digest. A floating tag would let a rebuilt
# release differ from the one that was verified.
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS base
ENV NODE_ENV=production
WORKDIR /srv/trialoom

# NODE_ENV=production makes npm omit devDependencies, which the build needs.
FROM base AS dependencies
# Wallet dependencies may compile native WebSocket helpers on this CPU. Keep
# the toolchain in the build stage; none of it is copied to the web image.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --include=dev

FROM dependencies AS build
COPY . .
RUN npm run build

# Next's standalone output carries only the modules its own trace proved
# reachable, so no project source and no build toolchain reach this image.
FROM base AS app
COPY --from=build --chown=node:node /srv/trialoom/.next/standalone ./
COPY --from=build --chown=node:node /srv/trialoom/.next/static ./.next/static
COPY --from=build --chown=node:node /srv/trialoom/public ./public
COPY scripts/container-entrypoint.sh /usr/local/bin/trialoom-entrypoint
RUN chmod 0755 /usr/local/bin/trialoom-entrypoint
USER node
ENV PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
# The entrypoint drops privileges if the host started this as root, and refuses
# to start if a configured evidence directory cannot be written. /api/health
# reports whether it is running privileged, so the result is checkable.
ENTRYPOINT ["/usr/local/bin/trialoom-entrypoint"]
# /api/ready is the deployment gate: it answers 503 until the schema is
# migrated, so an orchestrator can hold traffic instead of serving errors.
CMD ["node", "server.js"]

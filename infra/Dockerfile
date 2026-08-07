# The API and the worker, from one build.
#
# They share every dependency, every package in the workspace and every system
# library, and differ only in which entrypoint they run. Two Dockerfiles would
# be two places to remember to add ffmpeg to.
#
# Debian slim rather than Alpine on purpose. Prisma ships a musl engine but the
# combination of musl, Chromium and ffmpeg is a well-known source of "works on
# my machine": glibc is a hundred megabytes we can afford on a 100GB disk and
# an evening we cannot.

# Node 22, not 20. The lockfile is pnpm 9 format written by pnpm 11, and
# pnpm 11 uses builtins that Node 20 does not have: it dies on startup with
# ERR_UNKNOWN_BUILTIN_MODULE before it reads a single manifest.
FROM node:22-bookworm-slim AS base

# chromium renders every PDF this app produces: the monthly client report, the
#   game plan, invoices and the year-end Schedule C export. packages/media
#   looks for /usr/bin/chromium, which is exactly where Debian puts it.
# ffmpeg transcodes uploads and pulls thumbnails.
# poppler-utils gives pdftotext, because knowledge files include PDFs and a
#   brand deck nobody can read is a brand deck the model never sees.
# openssl is Prisma's; without it the query engine will not load.
# fonts-liberation stops the PDFs falling back to a boxes-and-question-marks
#   font for anything the embedded brand fonts do not cover.
# fontconfig is how libass resolves font names when captions are burned in.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       chromium \
       ffmpeg \
       openssl \
       poppler-utils \
       ca-certificates \
       fonts-liberation \
       fontconfig \
       tini \
  && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
# Pinned rather than @latest, so a pnpm release cannot change what this image
# resolves months from now. Matches the version that wrote pnpm-lock.yaml.
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate

WORKDIR /app


# ---------------------------------------------------------------------------
# Dependencies, cached on the manifests alone.
#
# Only the package.json files are copied first, so editing a source file does
# not invalidate the install layer. The whole workspace's manifests are needed
# because pnpm resolves the graph before it fetches anything.
# ---------------------------------------------------------------------------
FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json        apps/api/
COPY apps/worker/package.json     apps/worker/
COPY apps/desktop/package.json    apps/desktop/
COPY packages/core/package.json   packages/core/
COPY packages/db/package.json     packages/db/
COPY packages/media/package.json  packages/media/
COPY packages/publishers/package.json packages/publishers/

# Dev dependencies included, because the server runs its TypeScript directly
# through tsx rather than compiling first, and tsx lives in devDependencies.
# --ignore-scripts would skip Prisma's engine download, so it stays off.
RUN pnpm install --frozen-lockfile --filter "@toreroflow/api..." --filter "@toreroflow/worker..."


# ---------------------------------------------------------------------------
# The application, with the Prisma client generated against the real schema.
# ---------------------------------------------------------------------------
FROM deps AS build

COPY packages/ packages/
COPY apps/api/ apps/api/
COPY apps/worker/ apps/worker/
COPY assets/ assets/

# The generated client is architecture specific, so it is generated here rather
# than copied from the developer's machine.
RUN pnpm --filter @toreroflow/db exec prisma generate

# Caption burn-in needs the brand fonts resolvable by libass.
COPY assets/fonts /usr/local/share/fonts/toreroflow
RUN fc-cache -f

# Where uploads, thumbnails and rendered PDFs live. A named volume mounts over
# this in compose; creating it here means the image also runs standalone.
RUN mkdir -p /app/storage
ENV NODE_ENV=production \
    STORAGE_DIR=/app/storage

# tini reaps the zombies ffmpeg and chromium leave behind. Without it a
# container that has rendered a few hundred PDFs collects defunct processes
# until it runs out of them.
ENTRYPOINT ["/usr/bin/tini", "--"]


# ---------------------------------------------------------------------------
# The two things that actually run.
# ---------------------------------------------------------------------------
FROM build AS api
COPY infra/api-entrypoint.sh /usr/local/bin/api-entrypoint.sh
RUN chmod +x /usr/local/bin/api-entrypoint.sh
EXPOSE 4700
CMD ["/usr/local/bin/api-entrypoint.sh"]

FROM build AS worker
CMD ["pnpm", "--filter", "@toreroflow/worker", "start"]

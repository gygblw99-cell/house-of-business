FROM node:20-alpine AS builder

WORKDIR /app

ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

ARG NEXT_PUBLIC_WEBSITE_URL
ENV NEXT_PUBLIC_WEBSITE_URL=$NEXT_PUBLIC_WEBSITE_URL

COPY package*.json ./
RUN npm ci

COPY . .

# Fail the build loudly instead of silently baking a localhost URL into the
# production client bundle if the Railway build variable wasn't set.
RUN test -n "$NEXT_PUBLIC_API_URL" || (echo "ERROR: NEXT_PUBLIC_API_URL build arg is required" && exit 1)
RUN test -n "$NEXT_PUBLIC_WEBSITE_URL" || (echo "ERROR: NEXT_PUBLIC_WEBSITE_URL build arg is required" && exit 1)

RUN npm run build

# ── Production image ──────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

USER node

EXPOSE 3000

# Shell form (no brackets) so ${PORT:-3000} is expanded at runtime by /bin/sh
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/ || exit 1

CMD ["node", "server.js"]

FROM oven/bun:1.4.0-alpine AS dependencies
WORKDIR /app
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS build
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN bun run build

FROM build AS test-runtime
COPY test ./test
COPY scripts ./scripts

FROM oven/bun:1.4.0-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist

USER bun
EXPOSE 3000

CMD ["bun", "dist/main.js"]

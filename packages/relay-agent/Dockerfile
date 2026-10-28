# Build from the repository root:  docker build -f packages/relay-agent/Dockerfile -t atlas-relay-agent .
FROM node:22-alpine AS build
WORKDIR /app
COPY packages/relay-agent/package.json packages/relay-agent/tsconfig.json packages/relay-agent/tsconfig.build.json ./
COPY packages/relay-agent/src ./src
COPY tsconfig.base.json /tsconfig.base.json
RUN npm install --omit=dev --no-package-lock ldapts@^7.4.0 && npm install --no-package-lock --no-save typescript@5 @types/node@22 && sed -i 's#../../tsconfig.base.json#/tsconfig.base.json#' tsconfig.json && npx tsc -p tsconfig.build.json

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
ENTRYPOINT ["node", "dist/main.js"]

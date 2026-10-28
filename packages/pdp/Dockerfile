# Atlas local PDP sidecar. Build context: the package directory after `pnpm build`.
FROM node:22-alpine
WORKDIR /app
COPY dist ./dist
COPY package.json ./
ENV HOST=0.0.0.0 PORT=8181
EXPOSE 8181
USER node
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8181/healthz || exit 1
ENTRYPOINT ["node", "dist/cli.js"]

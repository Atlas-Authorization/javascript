# docker build -t atlas-emulator -f packages/emulator/Dockerfile packages/emulator
# (after `pnpm --filter @atlasauth/emulator build`). Mount a seed file and pass --seed.
FROM node:22-alpine
WORKDIR /app
COPY dist ./dist
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts
EXPOSE 4400
ENTRYPOINT ["node", "dist/bin.js", "--host", "0.0.0.0"]

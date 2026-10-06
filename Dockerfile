# One image definition for every Cloud Run service; pick the service with --build-arg SERVICE=<name>.
#   docker build --build-arg SERVICE=collector -t cp-collector .
# Deploys go through Cloud Build (infra/cloudbuild.yaml) via `pnpm deploy:<service>`.

FROM node:22-slim AS build
WORKDIR /repo
RUN npm install -g pnpm@12.6.0
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile \
 && pnpm build \
 && pnpm install --offline --frozen-lockfile --prod

FROM node:22-slim
ARG SERVICE
ENV NODE_ENV=production \
    SERVICE=${SERVICE} \
    HOST=0.0.0.0 \
    PORT=8080
WORKDIR /repo
COPY --from=build --chown=node:node /repo /repo
USER node
EXPOSE 8080
CMD ["sh", "-c", "exec node apps/${SERVICE}/dist/index.js"]

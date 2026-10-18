# One image definition for every Cloud Run service; pick the service with --build-arg SERVICE=<name>.
#   docker build --build-arg SERVICE=collector -t cp-collector .
# Deploys go through Cloud Build (infra/cloudbuild.yaml) via `pnpm deploy:<service>`.

FROM node:22-slim AS build
ARG SERVICE
ARG VITE_CP_COLLECTOR=http://localhost:8080
ARG VITE_CP_DASHBOARD=http://localhost:5174
ARG VITE_CP_SITE_KEY=pk_local_demo
ARG VITE_CP_SHOP_URL=http://localhost:5173
ENV VITE_CP_COLLECTOR=$VITE_CP_COLLECTOR VITE_CP_DASHBOARD=$VITE_CP_DASHBOARD VITE_CP_SITE_KEY=$VITE_CP_SITE_KEY VITE_CP_SHOP_URL=$VITE_CP_SHOP_URL
WORKDIR /repo
RUN npm install -g pnpm@12.6.0
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile \
 && pnpm build \
 && if [ "$SERVICE" = "api" ]; then pnpm --filter @cp/dashboard build && pnpm --filter @cp/demo-shop build; fi \
 && pnpm install --offline --frozen-lockfile --prod

FROM node:22-slim
ARG SERVICE
ENV NODE_ENV=production \
    SERVICE=${SERVICE} \
    HOST=0.0.0.0 \
    PORT=8080
WORKDIR /repo
COPY --from=build --chown=node:node /repo /repo
# Only the agent renders screenshots (the visual check), so only its image carries a browser.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN if [ "$SERVICE" = "agent" ]; then node apps/agent/node_modules/playwright/cli.js install --with-deps chromium && chmod -R a+rX /ms-playwright; fi
USER node
EXPOSE 8080
CMD ["sh", "-c", "exec node apps/${SERVICE}/dist/index.js"]

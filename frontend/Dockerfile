# --- build ---
FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json components.json eslint.config.js ./
COPY public ./public
COPY src ./src

ARG VITE_API_URL=http://localhost:8000/api
ARG VITE_WS_URL=ws://localhost:8000
ARG VITE_META_APP_ID=
ARG VITE_WHATSAPP_CONFIGURATION_ID=
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL
ENV VITE_META_APP_ID=$VITE_META_APP_ID
ENV VITE_WHATSAPP_CONFIGURATION_ID=$VITE_WHATSAPP_CONFIGURATION_ID

RUN npm run build

# --- static ---
FROM nginx:1.27-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

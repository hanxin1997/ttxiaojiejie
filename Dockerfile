FROM node:24-alpine AS web-builder
WORKDIR /build

COPY web/package.json web/package-lock.json* ./
RUN npm install

COPY web/ ./
RUN npm run build:only

FROM node:24-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server ./server
COPY --from=web-builder /public ./public

ENV PORT=4321
ENV DATA_DIR=/data
ENV LIBRARY_ROOT=/library
ENV SCAN_INTERVAL_MINUTES=15

EXPOSE 4321

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:4321/api/health/ready || exit 1

CMD ["npm", "start"]

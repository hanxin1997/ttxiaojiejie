FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY public ./public
COPY server ./server

ENV PORT=4321
ENV DATA_DIR=/data
ENV LIBRARY_ROOT=/library
ENV SCAN_INTERVAL_MINUTES=15

EXPOSE 4321

CMD ["npm", "start"]

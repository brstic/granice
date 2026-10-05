# Granice – sajt i radnik kamera u istoj slici (docker-compose.yml ih pokreće kao dva servisa).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg procps ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
COPY deploy ./deploy
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3090
VOLUME /app/data
EXPOSE 3090
CMD ["node", "server/server.js"]

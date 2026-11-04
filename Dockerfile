FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && mkdir -p /app/data && chown node:node /app/data
COPY server ./server
COPY web ./web
USER node
ENV HOST=0.0.0.0 PORT=4310 DATA_DIR=/app/data
VOLUME ["/app/data"]
EXPOSE 4310
CMD ["node","server/index.mjs"]

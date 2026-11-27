FROM node:22-alpine
WORKDIR /app
COPY package.json config.json ./
COPY server ./server
COPY public ./public
COPY indicator ./indicator
COPY test ./test
RUN npm test
ENV HOST=0.0.0.0 PORT=8080 KS_CLOUD=1 KS_ALERTS_ONLY=1 KS_STATE=/app/data/state.json
EXPOSE 8080
CMD ["node", "server/index.js"]

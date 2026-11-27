FROM node:22-alpine
WORKDIR /app
COPY . .
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
# pass the webhook at run time:  docker run -d --restart always --env-file .env -e HOST=0.0.0.0 -p 8080:8080 -v ks-data:/app/data king-sniper
CMD ["node", "server/index.js"]

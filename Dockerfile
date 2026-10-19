FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/web.js"]

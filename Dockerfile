# Librería Samantha: la API (Fastify) sirve también la web compilada (React/Vite).
FROM node:22-slim
ENV NODE_ENV=production HTTPS_PORT=0 PORT=3001
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
# se instalan también las dependencias de desarrollo: hacen falta para compilar la web y para ejecutar tsx
RUN npm ci --include=dev
COPY . .
RUN npm run build -w web
WORKDIR /app/server
EXPOSE 3001
CMD ["npx", "tsx", "src/index.ts"]

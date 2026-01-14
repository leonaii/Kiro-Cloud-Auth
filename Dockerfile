# 构建阶段
FROM docker.1ms.run/node:20-slim AS builder

WORKDIR /app

# 安装 pnpm
RUN npm install -g pnpm

# 复制依赖文件
COPY package.json pnpm-lock.yaml ./

# 安装依赖（跳过 electron 相关）
RUN pnpm install --ignore-scripts

# 复制源代码
COPY . .

# 构建 Web 版本（只构建 renderer）
RUN pnpm exec vite build --config vite.config.web.ts

# 运行阶段
FROM docker.1ms.run/node:20-slim

WORKDIR /app

# 安装 pnpm
RUN npm install -g pnpm

# 复制构建产物
COPY --from=builder /app/dist/webui ./dist/webui
COPY --from=builder /app/server ./server

# 安装服务器依赖
WORKDIR /app/server
RUN pnpm install --prod

# 回到根目录
WORKDIR /app

# 在构建时生成版本号（格式：年月日.时分秒）
RUN echo "APP_VERSION=$(date +%Y%m%d.%H%M%S)" >> /app/.env

# 暴露端口
EXPOSE 3000

# 设置 Node.js 内存限制（12G 服务器可用 8G 给 Node）
ENV NODE_OPTIONS="--max-old-space-size=8192"

# 集群模式 worker 数量（默认使用全部 CPU 核心）
ENV CLUSTER_WORKERS=""

# 启动时读取版本号并启动服务（使用集群模式）
CMD ["sh", "-c", "export $(cat /app/.env) && node server/cluster.js"]

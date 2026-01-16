#!/bin/bash
# Kiro-Cloud-Auth  - 服务器部署脚本
# Usage: ./run-docker.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 服务名称
SERVICE_1="Kiro-Cloud-Auth-1"
SERVICE_2="Kiro-Cloud-Auth-2"
SERVICE_BLUE="Kiro-Cloud-Auth-blue"
NGINX_SERVICE="nginx"
HEALTH_URL="http://127.0.0.1:25000/api/health"
HEALTH_URL_GREEN="http://127.0.0.1:25001/api/health"
HEALTH_URL_BLUE="http://127.0.0.1:25002/api/health"
MAX_WAIT=90  # 最大等待时间（秒）

# ========== 双实例开关 ==========
# 设置为 true 启用双实例，false 仅启用单实例
ENABLE_SERVICE_2=false
# ================================

# ========== 蓝绿部署开关 ==========
# 设置为 true 启用蓝绿部署（零停机），false 使用传统滚动更新
# 注意：已改回单实例部署模式，不再使用蓝绿部署
ENABLE_BLUE_GREEN=false
# ==================================

echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}Kiro-Cloud-Auth  - Server Deploy${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# 拉取最新代码
pull_latest() {
    echo -e "${YELLOW}[GIT] Pulling latest code...${NC}"
    git fetch --all
    git reset --hard origin/$(git rev-parse --abbrev-ref HEAD)
    chmod +x run-docker.sh 2>/dev/null || true
    COMMIT=$(git rev-parse --short HEAD)
    echo -e "${GREEN}[OK] Updated to $COMMIT${NC}"
}

# 使用 dev 环境配置
use_dev() {
    if [ -f ".env.dev" ]; then
        cp .env.dev .env
        echo -e "${GREEN}[OK] Using dev environment${NC}"
    else
        echo -e "${RED}[ERROR] .env.dev not found${NC}"
        exit 1
    fi
}

# 使用 pro 环境配置
use_pro() {
    if [ -f ".env.pro" ]; then
        cp .env.pro .env
        echo -e "${GREEN}[OK] Using pro environment${NC}"
    else
        echo -e "${RED}[ERROR] .env.pro not found${NC}"
        exit 1
    fi
}

# 根据实例模式选择 nginx 配置
setup_nginx_config() {
    if [ "$ENABLE_SERVICE_2" = "true" ]; then
        echo -e "${CYAN}[NGINX] Using dual-instance config (nginx.conf)${NC}"
        cp nginx.conf nginx.active.conf
    else
        echo -e "${CYAN}[NGINX] Using single-instance config (nginx-single.conf)${NC}"
        cp nginx-single.conf nginx.active.conf
    fi
}

# 等待服务健康
wait_for_healthy() {
    local url=$1
    local max_wait=$2
    local waited=0

    echo -e "${YELLOW}[WAIT] Waiting for service to be healthy...${NC}"

    while [ $waited -lt $max_wait ]; do
        if curl -s "$url" > /dev/null 2>&1; then
            echo -e "${GREEN}[OK] Service is healthy (${waited}s)${NC}"
            return 0
        fi
        sleep 1
        waited=$((waited + 1))
        # 每 5 秒打印一次进度
        if [ $((waited % 5)) -eq 0 ]; then
            echo -e "${YELLOW}[WAIT] Still waiting... (${waited}s)${NC}"
        fi
    done

    echo -e "${RED}[ERROR] Service failed to become healthy after ${max_wait}s${NC}"
    return 1
}

# 优雅停止容器（发送 SIGTERM 并等待）
graceful_stop_container() {
    local service=$1
    local timeout=${2:-15}  # 默认等待 15 秒

    local container_id=$(docker-compose ps -q $service 2>/dev/null || echo "")
    if [ -z "$container_id" ]; then
        echo -e "${CYAN}[GRACEFUL] $service is not running${NC}"
        return 0
    fi

    # echo -e "${YELLOW}[GRACEFUL] Sending SIGTERM to $service (timeout: ${timeout}s)...${NC}"
    # docker kill --signal=SIGTERM $container_id 2>/dev/null || true

    # # 等待容器优雅关闭
    # local waited=0
    # while [ $waited -lt $timeout ]; do
    #     local status=$(docker inspect --format='{{.State.Status}}' $container_id 2>/dev/null || echo "exited")
    #     if [ "$status" = "exited" ] || [ "$status" = "" ]; then
    #         echo -e "${GREEN}[GRACEFUL] $service stopped gracefully (${waited}s)${NC}"
    #         return 0
    #     fi
    #     sleep 1
    #     waited=$((waited + 1))
    # done

    echo -e "${YELLOW}[GRACEFUL] $service did not stop in time, will be force-recreated${NC}"
    return 0
}

# 蓝绿部署（真正的零停机）
# 流程：
# 1. 构建新镜像
# 2. 启动蓝实例（端口 25002）
# 3. 等待蓝实例健康
# 4. 切换 Nginx 到蓝实例
# 5. 优雅停止绿实例（端口 25001）
# 6. 用新镜像启动绿实例
# 7. 等待绿实例健康
# 8. 切换 Nginx 回绿实例
# 9. 停止蓝实例
do_deploy_blue_green() {
    local env_file=$1
    echo -e "${CYAN}========================================${NC}"
    echo -e "${CYAN}[BLUE-GREEN] Starting Blue-Green Deployment${NC}"
    echo -e "${CYAN}========================================${NC}"
    echo ""

    # 1. 构建新镜像
    echo -e "${YELLOW}[STEP 1/9] Building new image...${NC}"
    docker-compose build --no-cache
    echo -e "${GREEN}[OK] Image built${NC}"
    echo ""

    # 2. 启动蓝实例
    echo -e "${YELLOW}[STEP 2/9] Starting BLUE instance (port 25002)...${NC}"
    docker-compose --profile blue-green up -d $SERVICE_BLUE
    echo -e "${GREEN}[OK] Blue instance started${NC}"
    echo ""

    # 3. 等待蓝实例健康
    echo -e "${YELLOW}[STEP 3/9] Waiting for BLUE instance to be healthy...${NC}"
    local blue_ready=0
    for i in $(seq 1 60); do
        if curl -s "$HEALTH_URL_BLUE" > /dev/null 2>&1; then
            blue_ready=1
            echo -e "${GREEN}[OK] Blue instance is healthy (${i}s)${NC}"
            break
        fi
        sleep 1
        if [ $((i % 10)) -eq 0 ]; then
            echo -e "${YELLOW}[WAIT] Still waiting for blue instance... (${i}s)${NC}"
        fi
    done

    if [ $blue_ready -eq 0 ]; then
        echo -e "${RED}[ERROR] Blue instance failed to become healthy${NC}"
        echo -e "${YELLOW}[ROLLBACK] Stopping blue instance...${NC}"
        docker-compose --profile blue-green stop $SERVICE_BLUE 2>/dev/null || true
        exit 1
    fi
    echo ""

    # 4. 切换 Nginx 到蓝实例
    echo -e "${YELLOW}[STEP 4/9] Switching Nginx to BLUE instance...${NC}"
    if [ ! -f "nginx-blue.conf" ]; then
        echo -e "${RED}[ERROR] nginx-blue.conf not found${NC}"
        echo -e "${YELLOW}[ROLLBACK] Stopping blue instance...${NC}"
        graceful_stop_container $SERVICE_BLUE 10
        docker-compose --profile blue-green stop $SERVICE_BLUE 2>/dev/null || true
        exit 1
    fi
    cp nginx-blue.conf nginx.active.conf
    docker-compose exec -T $NGINX_SERVICE nginx -s reload 2>/dev/null || {
        echo -e "${YELLOW}[WARN] Nginx reload failed, recreating...${NC}"
        docker-compose up -d --no-deps --force-recreate $NGINX_SERVICE
    }
    # 验证流量已切换到蓝实例
    sleep 2
    echo -e "${GREEN}[OK] Traffic switched to BLUE instance${NC}"
    echo ""

    # 5. 优雅停止绿实例
    echo -e "${YELLOW}[STEP 5/9] Gracefully stopping GREEN instance (port 25001)...${NC}"
    graceful_stop_container $SERVICE_1 15
    echo -e "${GREEN}[OK] Green instance stopped${NC}"
    echo ""

    # 6. 用新镜像启动绿实例
    echo -e "${YELLOW}[STEP 6/9] Starting GREEN instance with new image...${NC}"
    docker-compose up -d --no-deps --force-recreate $SERVICE_1
    echo -e "${GREEN}[OK] Green instance started${NC}"
    echo ""

    # 7. 等待绿实例健康
    echo -e "${YELLOW}[STEP 7/9] Waiting for GREEN instance to be healthy...${NC}"
    local green_ready=0
    for i in $(seq 1 60); do
        if curl -s "$HEALTH_URL_GREEN" > /dev/null 2>&1; then
            green_ready=1
            echo -e "${GREEN}[OK] Green instance is healthy (${i}s)${NC}"
            break
        fi
        sleep 1
        if [ $((i % 10)) -eq 0 ]; then
            echo -e "${YELLOW}[WAIT] Still waiting for green instance... (${i}s)${NC}"
        fi
    done

    if [ $green_ready -eq 0 ]; then
        echo -e "${RED}[ERROR] Green instance failed to become healthy${NC}"
        echo -e "${YELLOW}[WARN] Keeping blue instance as primary${NC}"
        echo -e "${YELLOW}[INFO] Traffic is still being served by BLUE instance (port 25002)${NC}"
        echo -e "${YELLOW}[INFO] To retry, run: docker-compose up -d --no-deps --force-recreate $SERVICE_1${NC}"
        # 不退出，保持蓝实例运行
        return 1
    fi
    echo ""

    # 8. 切换 Nginx 回绿实例
    echo -e "${YELLOW}[STEP 8/9] Switching Nginx back to GREEN instance...${NC}"
    if [ ! -f "nginx-single.conf" ]; then
        echo -e "${RED}[ERROR] nginx-single.conf not found${NC}"
        echo -e "${YELLOW}[WARN] Keeping blue instance as primary${NC}"
        return 1
    fi
    cp nginx-single.conf nginx.active.conf
    docker-compose exec -T $NGINX_SERVICE nginx -s reload 2>/dev/null || {
        echo -e "${YELLOW}[WARN] Nginx reload failed, recreating...${NC}"
        docker-compose up -d --no-deps --force-recreate $NGINX_SERVICE
    }
    sleep 2
    echo -e "${GREEN}[OK] Traffic switched back to GREEN instance${NC}"
    echo ""

    # 9. 停止蓝实例
    echo -e "${YELLOW}[STEP 9/9] Stopping BLUE instance...${NC}"
    graceful_stop_container $SERVICE_BLUE 10
    docker-compose --profile blue-green stop $SERVICE_BLUE 2>/dev/null || true
    echo -e "${GREEN}[OK] Blue instance stopped${NC}"
    echo ""

    # 最终健康检查
    if wait_for_healthy "$HEALTH_URL" 30; then
        echo -e "${GREEN}========================================${NC}"
        echo -e "${GREEN}[SUCCESS] Blue-Green Deployment Complete!${NC}"
        echo -e "${GREEN}========================================${NC}"
        echo -e "${GREEN}Service available at http://localhost:25000${NC}"
    else
        echo -e "${RED}[ERROR] Final health check failed${NC}"
        exit 1
    fi

    # 清理旧镜像
    docker image prune -f 2>/dev/null || true
}

# 传统滚动更新（有短暂中断）
do_deploy_rolling() {
    local env_file=$1
    echo -e "${YELLOW}[DEPLOY] Starting rolling deployment (may have brief interruption)...${NC}"
    echo -e "${CYAN}[CONFIG] Dual instance mode: ${ENABLE_SERVICE_2}${NC}"

    # 1. 设置 nginx 配置
    setup_nginx_config

    # 2. 构建新镜像
    echo -e "${YELLOW}[BUILD] Building new image...${NC}"
    docker-compose build --no-cache

    # 3. 优雅停止并更新实例 1
    echo -e "${YELLOW}[UPDATE] Updating instance 1...${NC}"
    graceful_stop_container $SERVICE_1 10
    docker-compose up -d --no-deps --force-recreate $SERVICE_1

    # 等待实例 1 启动并健康
    echo -e "${YELLOW}[WAIT] Waiting for instance 1 to be ready...${NC}"
    sleep 3
    local instance1_ready=0
    for i in $(seq 1 20); do
        if curl -s "$HEALTH_URL_GREEN" > /dev/null 2>&1; then
            instance1_ready=1
            echo -e "${GREEN}[OK] Instance 1 is ready (${i}s)${NC}"
            break
        fi
        sleep 1
    done

    if [ $instance1_ready -eq 0 ]; then
        echo -e "${YELLOW}[WARN] Instance 1 health check timeout, continuing...${NC}"
    fi

    # 4. 滚动更新实例 2（如果启用）
    if [ "$ENABLE_SERVICE_2" = "true" ]; then
        echo -e "${YELLOW}[UPDATE] Updating instance 2...${NC}"
        graceful_stop_container $SERVICE_2 10
        docker-compose up -d --no-deps --force-recreate $SERVICE_2
        sleep 3
    else
        echo -e "${CYAN}[SKIP] Instance 2 disabled, skipping...${NC}"
        # 确保实例 2 已停止
        docker-compose stop $SERVICE_2 2>/dev/null || true
    fi

    # 5. 重新加载 Nginx 配置（不重启，避免中断）
    echo -e "${YELLOW}[UPDATE] Reloading Nginx...${NC}"
    docker-compose exec -T $NGINX_SERVICE nginx -s reload 2>/dev/null || {
        # 如果 reload 失败，则重启 nginx
        echo -e "${YELLOW}[UPDATE] Nginx reload failed, recreating...${NC}"
        docker-compose up -d --no-deps --force-recreate $NGINX_SERVICE
    }

    # 6. 等待服务健康
    if wait_for_healthy "$HEALTH_URL" $MAX_WAIT; then
        echo -e "${GREEN}[OK] All services are healthy${NC}"

        # 7. 清理旧镜像
        docker image prune -f 2>/dev/null || true

        echo -e "${GREEN}[OK] Rolling deployment completed!${NC}"
        echo -e "${GREEN}[OK] Service available at http://localhost:25000${NC}"
    else
        echo -e "${RED}[ERROR] Deployment failed, services are not healthy${NC}"
        echo -e "${YELLOW}[DEBUG] Check logs with: docker-compose logs${NC}"
        exit 1
    fi
}

# 零停机部署（根据配置选择蓝绿或滚动）
do_deploy_zero_downtime() {
    local env_file=$1
    echo -e "${YELLOW}[DEPLOY] Starting zero-downtime deployment...${NC}"
    echo -e "${CYAN}[CONFIG] Blue-Green mode: ${ENABLE_BLUE_GREEN}${NC}"
    echo -e "${CYAN}[CONFIG] Dual instance mode: ${ENABLE_SERVICE_2}${NC}"

    pull_latest

    if [ "$env_file" = "pro" ]; then
        use_pro
    else
        use_dev
    fi

    # 根据配置选择部署方式
    if [ "$ENABLE_BLUE_GREEN" = "true" ] && [ "$ENABLE_SERVICE_2" = "false" ]; then
        # 单实例模式下使用蓝绿部署
        do_deploy_blue_green "$env_file"
    else
        # 双实例模式或禁用蓝绿时使用滚动更新
        do_deploy_rolling "$env_file"
    fi
}

# 1. 部署/更新 (pro) - 零停机
do_deploy() {
    do_deploy_zero_downtime "pro"
}

# 2. 部署/更新 (dev) - 零停机
do_deploy_dev() {
    do_deploy_zero_downtime "dev"
}

# 快速部署（有停机，但更快）
do_deploy_fast() {
    echo -e "${YELLOW}[DEPLOY] Starting fast deployment (with downtime)...${NC}"
    echo -e "${CYAN}[CONFIG] Dual instance mode: ${ENABLE_SERVICE_2}${NC}"
    pull_latest
    use_pro
    setup_nginx_config
    docker-compose down 2>/dev/null || true

    # 根据模式启动服务
    if [ "$ENABLE_SERVICE_2" = "true" ]; then
        docker-compose up -d --build $SERVICE_1 $SERVICE_2 $NGINX_SERVICE
    else
        docker-compose up -d --build $SERVICE_1 $NGINX_SERVICE
    fi

    docker image prune -f 2>/dev/null || true
    echo -e "${GREEN}[OK] Deployed! http://localhost:25000${NC}"
}

# 3. 停止
do_stop() {
    echo -e "${YELLOW}[STOP] Stopping all services...${NC}"
    docker-compose down
    echo -e "${GREEN}[OK] Stopped${NC}"
}

# 4. 查看日志
do_logs() {
    echo -e "${CYAN}Select log target:${NC}"
    echo "  1) All services"
    echo "  2) Instance 1 only"
    if [ "$ENABLE_SERVICE_2" = "true" ]; then
        echo "  3) Instance 2 only"
    fi
    echo "  4) Nginx only"
    read -p "Enter choice [1-4]: " log_choice
    case "$log_choice" in
        1) docker-compose logs -f ;;
        2) docker-compose logs -f $SERVICE_1 ;;
        3)
            if [ "$ENABLE_SERVICE_2" = "true" ]; then
                docker-compose logs -f $SERVICE_2
            else
                echo -e "${YELLOW}Instance 2 is disabled${NC}"
            fi
            ;;
        4) docker-compose logs -f $NGINX_SERVICE ;;
        *) docker-compose logs -f ;;
    esac
}

# 5. 查看状态
do_status() {
    echo -e "${CYAN}[CONFIG] Dual instance mode: ${ENABLE_SERVICE_2}${NC}"
    echo ""
    echo -e "${CYAN}[STATUS] Container Status:${NC}"
    docker-compose ps
    echo ""

    echo -e "${CYAN}[HEALTH] Service Health:${NC}"
    if curl -s "$HEALTH_URL" > /dev/null 2>&1; then
        echo -e "${GREEN}[OK] Nginx Load Balancer: healthy${NC}"
        curl -s "$HEALTH_URL" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  Version: {d.get(\"version\",\"N/A\")}')" 2>/dev/null || true
    else
        echo -e "${RED}[ERROR] Nginx Load Balancer: not responding${NC}"
    fi

    # 检查各实例
    echo ""
    echo -e "${CYAN}[INSTANCES] Backend Instances:${NC}"

    # 实例 1
    container_id=$(docker-compose ps -q $SERVICE_1 2>/dev/null || echo "")
    if [ -n "$container_id" ]; then
        status=$(docker inspect --format='{{.State.Status}}' $container_id 2>/dev/null || echo "unknown")
        echo -e "  $SERVICE_1: $status"
    else
        echo -e "  $SERVICE_1: not running"
    fi

    # 实例 2（显示是否启用）
    if [ "$ENABLE_SERVICE_2" = "true" ]; then
        container_id=$(docker-compose ps -q $SERVICE_2 2>/dev/null || echo "")
        if [ -n "$container_id" ]; then
            status=$(docker inspect --format='{{.State.Status}}' $container_id 2>/dev/null || echo "unknown")
            echo -e "  $SERVICE_2: $status"
        else
            echo -e "  $SERVICE_2: not running"
        fi
    else
        echo -e "  $SERVICE_2: ${YELLOW}disabled${NC}"
    fi
}

# 6. 清理
do_clean() {
    echo -e "${YELLOW}[CLEAN] Cleaning all resources...${NC}"
    docker-compose down -v --rmi local 2>/dev/null || true
    docker image prune -f
    echo -e "${GREEN}[OK] Cleaned${NC}"
}

# 7. 重启（零停机滚动重启）
do_restart() {
    echo -e "${YELLOW}[RESTART] Rolling restart...${NC}"
    echo -e "${CYAN}[CONFIG] Dual instance mode: ${ENABLE_SERVICE_2}${NC}"

    # 确保 nginx 配置正确
    setup_nginx_config

    # 优雅停止并重启实例 1
    echo -e "${YELLOW}[RESTART] Restarting instance 1...${NC}"
    graceful_stop_container $SERVICE_1 10
    docker-compose up -d --no-deps --force-recreate $SERVICE_1

    # 等待实例 1 启动
    echo -e "${YELLOW}[WAIT] Waiting for instance 1 to be ready...${NC}"
    sleep 3
    for i in $(seq 1 15); do
        if curl -s "http://127.0.0.1:25001/api/health" > /dev/null 2>&1; then
            echo -e "${GREEN}[OK] Instance 1 is ready (${i}s)${NC}"
            break
        fi
        sleep 1
    done

    # 滚动重启实例 2（如果启用）
    if [ "$ENABLE_SERVICE_2" = "true" ]; then
        echo -e "${YELLOW}[RESTART] Restarting instance 2...${NC}"
        graceful_stop_container $SERVICE_2 10
        docker-compose up -d --no-deps --force-recreate $SERVICE_2
        sleep 3
    else
        echo -e "${CYAN}[SKIP] Instance 2 disabled, skipping...${NC}"
        # 确保实例 2 已停止
        docker-compose stop $SERVICE_2 2>/dev/null || true
    fi

    # 重新加载 Nginx 配置
    echo -e "${YELLOW}[RESTART] Reloading Nginx...${NC}"
    docker-compose exec -T $NGINX_SERVICE nginx -s reload 2>/dev/null || {
        docker-compose up -d --no-deps --force-recreate $NGINX_SERVICE
    }

    # 等待健康
    if wait_for_healthy "$HEALTH_URL" $MAX_WAIT; then
        echo -e "${GREEN}[OK] Rolling restart completed${NC}"
    else
        echo -e "${RED}[ERROR] Restart failed${NC}"
        exit 1
    fi
}

# 8. 扩缩容（单实例模式）
do_scale_single() {
    echo -e "${YELLOW}[SCALE] Switching to single instance mode...${NC}"

    # 切换 nginx 配置
    cp nginx-single.conf nginx.active.conf
    echo -e "${CYAN}[NGINX] Switched to single-instance config${NC}"

    # 停止实例 2
    docker-compose stop $SERVICE_2 2>/dev/null || true

    # 重启 nginx 以应用新配置
    docker-compose up -d --no-deps --force-recreate $NGINX_SERVICE

    echo -e "${GREEN}[OK] Now running single instance${NC}"
    echo -e "${YELLOW}[TIP] To persist this setting, edit ENABLE_SERVICE_2=false in run-docker.sh${NC}"
}

# 9. 扩缩容（双实例模式）
do_scale_double() {
    echo -e "${YELLOW}[SCALE] Switching to double instance mode...${NC}"

    # 切换 nginx 配置
    cp nginx.conf nginx.active.conf
    echo -e "${CYAN}[NGINX] Switched to dual-instance config${NC}"

    # 启动实例 2
    docker-compose up -d $SERVICE_2

    # 重启 nginx 以应用新配置
    docker-compose up -d --no-deps --force-recreate $NGINX_SERVICE

    echo -e "${GREEN}[OK] Now running double instances${NC}"
    echo -e "${YELLOW}[TIP] To persist this setting, edit ENABLE_SERVICE_2=true in run-docker.sh${NC}"
}

# 显示菜单
show_menu() {
    echo -e "${CYAN}Select an option:${NC}"
    echo ""
    echo "  1) Deploy (pro)     - Zero-downtime deploy with .env.pro"
    echo "  2) Deploy (dev)     - Zero-downtime deploy with .env.dev"
    echo "  3) Stop             - Stop all services"
    echo "  4) Logs             - View logs"
    echo "  5) Status           - Check status"
    echo "  6) Clean            - Remove all"
    echo "  7) Restart          - Rolling restart"
    echo "  8) Fast Deploy      - Quick deploy (with downtime)"
    echo "  9) Scale Single     - Run single instance"
    echo "  10) Scale Double    - Run double instances"
    echo "  0) Exit"
    echo ""
}

# 主入口
if [ -n "$1" ]; then
    case "$1" in
        1|deploy|pro) do_deploy ;;
        2|dev) do_deploy_dev ;;
        3|stop) do_stop ;;
        4|logs) do_logs ;;
        5|status) do_status ;;
        6|clean) do_clean ;;
        7|restart) do_restart ;;
        8|fast) do_deploy_fast ;;
        9|single) do_scale_single ;;
        10|double) do_scale_double ;;
        *) echo "Invalid option"; exit 1 ;;
    esac
else
    while true; do
        show_menu
        read -p "Enter choice [0-10]: " choice
        echo ""

        case "$choice" in
            1) do_deploy ;;
            2) do_deploy_dev ;;
            3) do_stop ;;
            4) do_logs ;;
            5) do_status ;;
            6) do_clean ;;
            7) do_restart ;;
            8) do_deploy_fast ;;
            9) do_scale_single ;;
            10) do_scale_double ;;
            0|q|exit) echo "Bye!"; exit 0 ;;
            *) echo -e "${RED}Invalid option${NC}" ;;
        esac

        echo ""
        read -p "Press Enter to continue..."
        clear
        echo -e "${CYAN}========================================${NC}"
        echo -e "${CYAN}Kiro-Cloud-Auth  - Server Deploy${NC}"
        echo -e "${CYAN}========================================${NC}"
        echo ""
    done
fi

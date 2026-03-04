#!/bin/bash
set -e

# 生产部署脚本
echo "🚀 开始 AgentGuard 生产部署..."

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# 检查环境
check_requirements() {
    echo "📋 检查系统要求..."

    # 检查 Docker
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}❌ Docker 未安装${NC}"
        exit 1
    fi

    # 检查 Docker Compose
    if ! command -v docker-compose &> /dev/null; then
        echo -e "${RED}❌ Docker Compose 未安装${NC}"
        exit 1
    fi

    # 检查端口
    for port in 80 443 8080 3000; do
        if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null ; then
            echo -e "${YELLOW}⚠️  端口 $port 已被占用${NC}"
            read -p "是否继续？(y/n) " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                exit 1
            fi
        fi
    done

    echo -e "${GREEN}✅ 系统检查通过${NC}"
}

# 生成密钥
generate_secrets() {
    echo "🔐 生成安全密钥..."

    if [ ! -f .env.production ]; then
        echo -e "${RED}❌ .env.production 文件不存在${NC}"
        exit 1
    fi

    # 生成随机密钥
    JWT_SECRET=$(openssl rand -base64 32)
    ENCRYPTION_KEY=$(openssl rand -base64 32)
    DB_PASSWORD=$(openssl rand -base64 16)
    REDIS_PASSWORD=$(openssl rand -base64 16)
    GRAFANA_PASSWORD=$(openssl rand -base64 12)

    # 更新环境变量
    sed -i.bak "s/your-very-long-random-secret-key-here-min-32-chars/$JWT_SECRET/g" .env.production
    sed -i.bak "s/another-very-long-random-key-for-encryption/$ENCRYPTION_KEY/g" .env.production
    sed -i.bak "s/secure_password/$DB_PASSWORD/g" .env.production

    echo -e "${GREEN}✅ 密钥生成完成${NC}"
}

# 设置 SSL 证书
setup_ssl() {
    echo "🔒 设置 SSL 证书..."

    mkdir -p nginx/certs

    if [ ! -f nginx/certs/fullchain.pem ]; then
        echo -e "${YELLOW}⚠️  未找到 SSL 证书${NC}"
        echo "选择证书配置方式："
        echo "1) 使用 Let's Encrypt (推荐)"
        echo "2) 使用自签名证书 (仅测试)"
        echo "3) 手动提供证书"
        read -p "请选择 (1/2/3): " choice

        case $choice in
            1)
                echo "请先配置域名指向此服务器，然后运行："
                echo "docker run -it --rm -v $PWD/nginx/certs:/etc/letsencrypt certbot/certbot certonly --standalone"
                exit 0
                ;;
            2)
                openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
                    -keyout nginx/certs/privkey.pem \
                    -out nginx/certs/fullchain.pem \
                    -subj "/C=CN/ST=State/L=City/O=Organization/CN=agentguard.local"
                ;;
            3)
                echo "请将证书文件放置到 nginx/certs/ 目录："
                echo "- fullchain.pem (证书链)"
                echo "- privkey.pem (私钥)"
                exit 0
                ;;
        esac
    fi

    echo -e "${GREEN}✅ SSL 证书配置完成${NC}"
}

# 创建必要目录
create_directories() {
    echo "📁 创建必要目录..."

    mkdir -p {logs/{gateway,nginx},data/uploads,backup/{postgres,redis},monitoring/grafana/dashboards}
    chmod -R 755 logs data backup monitoring

    echo -e "${GREEN}✅ 目录创建完成${NC}"
}

# 构建镜像
build_images() {
    echo "🏗️  构建 Docker 镜像..."

    docker-compose -f docker-compose.prod.yml build --parallel

    echo -e "${GREEN}✅ 镜像构建完成${NC}"
}

# 初始化数据库
init_database() {
    echo "🗄️  初始化数据库..."

    # 启动数据库
    docker-compose -f docker-compose.prod.yml up -d postgres
    sleep 10

    # 运行迁移
    docker-compose -f docker-compose.prod.yml run --rm gateway npm run db:migrate

    echo -e "${GREEN}✅ 数据库初始化完成${NC}"
}

# 启动服务
start_services() {
    echo "🚀 启动所有服务..."

    docker-compose -f docker-compose.prod.yml up -d

    echo -e "${GREEN}✅ 服务启动完成${NC}"
}

# 健康检查
health_check() {
    echo "🏥 执行健康检查..."

    sleep 30

    # 检查服务状态
    services=("gateway" "dashboard" "postgres" "redis" "nginx")
    for service in "${services[@]}"; do
        if [ "$(docker-compose -f docker-compose.prod.yml ps -q $service)" ]; then
            echo -e "${GREEN}✅ $service 运行正常${NC}"
        else
            echo -e "${RED}❌ $service 运行异常${NC}"
        fi
    done

    # 检查 API 健康
    if curl -f http://localhost/health >/dev/null 2>&1; then
        echo -e "${GREEN}✅ API 网关健康${NC}"
    else
        echo -e "${RED}❌ API 网关不健康${NC}"
    fi
}

# 显示访问信息
show_info() {
    echo ""
    echo "╔═══════════════════════════════════════════════════╗"
    echo "║          AgentGuard 生产部署完成! 🎉              ║"
    echo "╠═══════════════════════════════════════════════════╣"
    echo "║ 🌐 仪表板:  https://dashboard.agentguard.com      ║"
    echo "║ 🔌 API:     https://api.agentguard.com           ║"
    echo "║ 📊 监控:    https://monitoring.agentguard.com    ║"
    echo "║                                                   ║"
    echo "║ 📝 默认密码已生成，请查看 .env.production        ║"
    echo "║ 🔐 请立即修改所有默认密码!                       ║"
    echo "╚═══════════════════════════════════════════════════╝"
    echo ""
    echo "重要命令："
    echo "- 查看日志: docker-compose -f docker-compose.prod.yml logs -f"
    echo "- 停止服务: docker-compose -f docker-compose.prod.yml down"
    echo "- 备份数据: ./backup-production.sh"
    echo ""
}

# 主流程
main() {
    check_requirements
    generate_secrets
    setup_ssl
    create_directories
    build_images
    init_database
    start_services
    health_check
    show_info
}

# 执行部署
main
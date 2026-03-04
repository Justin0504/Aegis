#!/bin/bash
set -e

# 生产备份脚本
BACKUP_DIR="./backup/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

echo "🔄 开始备份 AgentGuard 生产数据..."

# 备份数据库
echo "📊 备份 PostgreSQL..."
docker-compose -f docker-compose.prod.yml exec -T postgres \
    pg_dump -U agentguard agentguard_prod | gzip > "$BACKUP_DIR/postgres_backup.sql.gz"

# 备份 Redis
echo "💾 备份 Redis..."
docker-compose -f docker-compose.prod.yml exec -T redis \
    redis-cli --rdb /backup/redis_backup.rdb BGSAVE

# 备份配置文件
echo "📋 备份配置文件..."
cp .env.production "$BACKUP_DIR/"
cp docker-compose.prod.yml "$BACKUP_DIR/"
cp -r nginx/certs "$BACKUP_DIR/certs"

# 备份上传的文件
echo "📁 备份上传文件..."
tar -czf "$BACKUP_DIR/uploads.tar.gz" data/uploads/

# 创建备份元数据
cat > "$BACKUP_DIR/backup_info.txt" << EOF
Backup Date: $(date)
Backup Type: Full
Components:
- PostgreSQL Database
- Redis Data
- Configuration Files
- SSL Certificates
- Uploaded Files
EOF

# 上传到 S3（如果配置）
if [ ! -z "$BACKUP_S3_BUCKET" ]; then
    echo "☁️  上传到 S3..."
    aws s3 sync "$BACKUP_DIR" "s3://$BACKUP_S3_BUCKET/$(basename $BACKUP_DIR)"
fi

# 清理旧备份（保留30天）
find ./backup -type d -mtime +30 -exec rm -rf {} \;

echo "✅ 备份完成！备份位置: $BACKUP_DIR"
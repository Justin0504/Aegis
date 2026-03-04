#!/bin/bash

echo "🚀 AgentGuard 快速启动脚本"
echo "=========================="

# 检查依赖
command -v node >/dev/null 2>&1 || { echo "❌ 需要安装 Node.js"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "❌ 需要安装 npm"; exit 1; }

echo "✅ 环境检查通过"

# 创建必要的目录
mkdir -p data logs

# 安装 core-schema 依赖
echo "📦 安装 core-schema..."
cd packages/core-schema
npm install --no-save
cd ../..

# 安装 gateway-mcp 依赖
echo "📦 安装 gateway-mcp..."
cd packages/gateway-mcp
npm install --no-save
cd ../..

# 安装 compliance-cockpit 依赖
echo "📦 安装 compliance-cockpit..."
cd apps/compliance-cockpit
npm install --no-save --legacy-peer-deps
cd ../..

echo "✨ 依赖安装完成！"
echo ""
echo "📋 启动说明："
echo "1. 启动 Gateway："
echo "   cd packages/gateway-mcp && npm run dev"
echo ""
echo "2. 启动 Dashboard (新终端)："
echo "   cd apps/compliance-cockpit && npm run dev"
echo ""
echo "3. 访问服务："
echo "   - Dashboard: http://localhost:3000"
echo "   - Gateway API: http://localhost:8080"
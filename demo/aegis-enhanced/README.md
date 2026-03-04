# Aegis Enhanced Dashboard

这是从 aegis-test 项目整合的增强版仪表板，具有以下特性：

## 特性

- 🎨 **Notion 风格 UI** - 专业的深色主题设计
- 📊 **实时监控** - WebSocket 实时数据更新
- 🚨 **异常检测** - 自动检测危险操作
- 📈 **高级分析** - 详细的指标和图表
- 🛡️ **动态代理跟踪** - 自动从追踪数据识别代理

## 快速开始

### 1. 安装依赖

```bash
cd demo/aegis-enhanced
npm install ws
```

### 2. 启动服务器

```bash
node server.js
```

服务器将在以下端口启动：
- 仪表板: http://localhost:8080
- API: http://localhost:8080/api/v1/traces
- WebSocket: ws://localhost:8080

### 3. 运行演示代理

在新的终端窗口：

```bash
python demo_agent.py
```

或运行多个代理：

```bash
python demo_agent.py &
python demo_agent_2.py &
```

## 文件说明

- `dashboard.html` - Notion 风格的仪表板 UI
- `server.js` - 增强的 Node.js 服务器，支持 WebSocket
- `demo_agent.py` - 主演示代理
- `demo_agent_2.py` - 第二个演示代理（不同的操作模式）

## 与原始 demo 的区别

原始 demo 使用简单的 HTTP 轮询，而这个增强版本使用：
- WebSocket 实时通信
- 更丰富的 UI 和交互
- 动态代理管理
- 高级策略配置
- 详细的系统设置

## 集成到主项目

要将这些功能集成到主 AgentGuard 项目：

1. 将 `dashboard.html` 的组件迁移到 `apps/compliance-cockpit`
2. 将 `server.js` 的 WebSocket 功能集成到 `packages/gateway-mcp`
3. 使用 `packages/sdk-python` 中的增强客户端功能
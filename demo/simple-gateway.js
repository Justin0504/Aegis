const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

// 创建数据库
const db = new sqlite3.Database(':memory:');

// 初始化数据库表
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT UNIQUE NOT NULL,
      agent_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      tool_call TEXT NOT NULL,
      approval_status TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// 根路径 - 显示欢迎页面
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Aegis Gateway</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          body {
            font-family: 'Inter', sans-serif;
            background: #0a0a0a;
            color: #e5e7eb;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .container {
            background: rgba(17, 17, 17, 0.7);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.05);
            padding: 60px;
            border-radius: 16px;
            max-width: 800px;
            width: 100%;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
          }
          h1 {
            font-size: 2.5rem;
            font-weight: 300;
            letter-spacing: -0.02em;
            margin-bottom: 8px;
            background: linear-gradient(to right, #e5e7eb, #9ca3af);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
          }
          .subtitle {
            color: #6b7280;
            margin-bottom: 48px;
            font-size: 14px;
            text-transform: uppercase;
            letter-spacing: 0.1em;
          }
          .status {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            color: #22c55e;
            font-size: 14px;
            margin-bottom: 40px;
          }
          .status::before {
            content: '';
            width: 8px;
            height: 8px;
            background: #22c55e;
            border-radius: 50%;
            animation: pulse 2s infinite;
          }
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
          }
          h2 {
            font-size: 1rem;
            font-weight: 500;
            margin-bottom: 20px;
            color: #9ca3af;
            text-transform: uppercase;
            letter-spacing: 0.05em;
          }
          .endpoint {
            background: rgba(31, 41, 55, 0.5);
            border: 1px solid rgba(75, 85, 99, 0.3);
            padding: 16px 20px;
            margin: 12px 0;
            border-radius: 8px;
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 14px;
            transition: all 0.2s ease;
          }
          .endpoint:hover {
            background: rgba(31, 41, 55, 0.8);
            border-color: rgba(75, 85, 99, 0.5);
            transform: translateX(4px);
          }
          a {
            color: #60a5fa;
            text-decoration: none;
            transition: color 0.2s;
          }
          a:hover {
            color: #93bbfc;
          }
          .dashboard-section {
            margin-top: 48px;
            padding-top: 48px;
            border-top: 1px solid rgba(75, 85, 99, 0.2);
          }
          .dashboard-btn {
            display: inline-flex;
            align-items: center;
            gap: 12px;
            background: linear-gradient(135deg, #1e293b, #334155);
            padding: 16px 32px;
            border-radius: 8px;
            color: #e5e7eb;
            text-decoration: none;
            font-weight: 500;
            transition: all 0.2s ease;
            margin-bottom: 16px;
          }
          .dashboard-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
          }
          .url-note {
            color: #4b5563;
            font-size: 12px;
            font-family: monospace;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>AEGIS</h1>
          <p class="subtitle">Security Gateway</p>
          <div class="status">System Operational</div>

          <h2>API Endpoints</h2>
          <div class="endpoint">
            GET <a href="/health">/health</a> - System health check
          </div>
          <div class="endpoint">
            GET <a href="/api/v1/traces">/api/v1/traces</a> - View all traces
          </div>
          <div class="endpoint">
            POST /api/v1/traces - Create new trace
          </div>

          <div class="dashboard-section">
            <h2>Security Dashboard</h2>
            <a href="/dashboard" class="dashboard-btn">
              Launch Dashboard
            </a>
            <p class="url-note">Direct access: http://localhost:8080/dashboard</p>
          </div>
        </div>
      </body>
    </html>
  `);
});

// 提供监控面板
app.get('/dashboard', (req, res) => {
  const dashboardPath = path.join(__dirname, 'dashboard.html');
  fs.readFile(dashboardPath, 'utf8', (err, content) => {
    if (err) {
      res.status(500).send('无法加载监控面板');
    } else {
      res.send(content);
    }
  });
});

// API 路由
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/v1/traces', (req, res) => {
  db.all('SELECT * FROM traces ORDER BY created_at DESC LIMIT 10', (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({
      traces: rows.map(row => ({
        ...row,
        tool_call: JSON.parse(row.tool_call)
      })),
      total: rows.length
    });
  });
});

app.post('/api/v1/traces', (req, res) => {
  const { trace_id, agent_id, tool_call } = req.body;

  db.run(
    'INSERT INTO traces (trace_id, agent_id, timestamp, tool_call, approval_status) VALUES (?, ?, ?, ?, ?)',
    [trace_id || Date.now().toString(), agent_id || 'demo-agent', new Date().toISOString(), JSON.stringify(tool_call || {}), 'APPROVED'],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ trace_id, message: 'Trace created' });
    }
  );
});

// 添加一些演示数据
const addDemoData = () => {
  const tools = ['read_file', 'write_file', 'execute_code', 'search_web'];
  const statuses = ['APPROVED', 'PENDING_APPROVAL', 'REJECTED', 'AUTO_APPROVED'];

  for (let i = 0; i < 5; i++) {
    db.run(
      'INSERT INTO traces (trace_id, agent_id, timestamp, tool_call, approval_status) VALUES (?, ?, ?, ?, ?)',
      [
        `trace-${Date.now()}-${i}`,
        'demo-agent-001',
        new Date(Date.now() - i * 60000).toISOString(),
        JSON.stringify({
          tool_name: tools[i % tools.length],
          function: tools[i % tools.length],
          arguments: { test: true }
        }),
        statuses[i % statuses.length]
      ]
    );
  }
};

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('\n\x1b[1mAEGIS GATEWAY\x1b[0m');
  console.log('─'.repeat(50));
  console.log(`\x1b[90mStatus:\x1b[0m     \x1b[92mOperational\x1b[0m`);
  console.log(`\x1b[90mPort:\x1b[0m       ${PORT}`);
  console.log(`\x1b[90mEnvironment:\x1b[0m Production`);
  console.log('─'.repeat(50));
  console.log('\x1b[90mEndpoints:\x1b[0m');
  console.log(`  http://localhost:${PORT}/              - Gateway Home`);
  console.log(`  http://localhost:${PORT}/dashboard     - Security Dashboard`);
  console.log(`  http://localhost:${PORT}/health        - Health Check`);
  console.log(`  http://localhost:${PORT}/api/v1/traces - Traces API`);
  console.log('─'.repeat(50));
  console.log('\x1b[90mInitializing demo data...\x1b[0m\n');
  addDemoData();
});
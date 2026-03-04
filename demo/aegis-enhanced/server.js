const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// Store traces in memory
const traces = [];
let stats = {
  totalOperations: 0,
  activeAgents: new Set(),
  anomaliesDetected: 0,
  errorCount: 0
};

// Create HTTP server
const server = http.createServer((req, res) => {
  console.log(`📥 ${req.method} ${req.url}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve the Notion-style dashboard
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'dashboard.html'), 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading dashboard');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // API endpoint for traces
  if (req.url === '/api/v1/traces') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        traces,
        stats: {
          ...stats,
          activeAgents: stats.activeAgents.size,
          errorRate: stats.totalOperations > 0
            ? ((stats.errorCount / stats.totalOperations) * 100).toFixed(1)
            : 0
        }
      }));
    } else if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const trace = JSON.parse(body);
          trace.trace_id = trace.trace_id || `trace-${Date.now()}${Math.random()}`;
          trace.timestamp = new Date().toISOString();
          traces.push(trace);

          // Update statistics
          stats.totalOperations++;
          stats.activeAgents.add(trace.agent_id);

          if (trace.status === 'error') {
            stats.errorCount++;
            // Check for anomalies
            if (trace.error &&
                (trace.error.includes('Dangerous') ||
                 trace.error.toLowerCase().includes('dangerous') ||
                 trace.tool_call.risk_level === 'HIGH')) {
              stats.anomaliesDetected++;
              console.log('🚨 Anomaly detected:', trace.agent_id, '-', trace.error);
            }
          }

          // Keep only last 100 traces
          if (traces.length > 100) traces.shift();

          // Broadcast to WebSocket clients
          broadcast(JSON.stringify({
            type: 'new_trace',
            data: trace
          }));

          // Send alert for high-risk failures
          if (trace.tool_call && trace.tool_call.risk_level === 'HIGH' && trace.status === 'error') {
            broadcast(JSON.stringify({
              type: 'alert',
              data: {
                message: `High-risk operation failed: ${trace.tool_call.tool_name}`,
                severity: 'critical',
                agent_id: trace.agent_id,
                error: trace.error
              }
            }));
          }

          console.log(`✅ Recorded trace from ${trace.agent_id}: ${trace.tool_call.tool_name}`);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, trace_id: trace.trace_id }));
        } catch (e) {
          console.error('❌ Error processing trace:', e);
          res.writeHead(400);
          res.end('Invalid JSON');
        }
      });
    }
    return;
  }

  // 404 for other routes
  res.writeHead(404);
  res.end('Not found');
});

// WebSocket server
const wss = new WebSocket.Server({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('🔌 WebSocket client connected. Total clients:', clients.size);

  // Send current state
  ws.send(JSON.stringify({
    type: 'initial_state',
    data: {
      traces,
      stats: {
        ...stats,
        activeAgents: stats.activeAgents.size,
        errorRate: stats.totalOperations > 0
          ? ((stats.errorCount / stats.totalOperations) * 100).toFixed(1)
          : 0
      }
    }
  }));

  ws.on('close', () => {
    clients.delete(ws);
    console.log('🔌 WebSocket client disconnected. Total clients:', clients.size);
  });

  ws.on('error', console.error);
});

function broadcast(message) {
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Start server
server.listen(8080, () => {
  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('║                                               ║');
  console.log('║   🎯 Aegis Real-Data Dashboard               ║');
  console.log('║                                               ║');
  console.log('║   Dashboard:  http://localhost:8080           ║');
  console.log('║   API:        http://localhost:8080/api/v1/traces  ║');
  console.log('║   WebSocket:  ws://localhost:8080             ║');
  console.log('║                                               ║');
  console.log('║   📌 只显示真实代理数据                       ║');
  console.log('║   🚀 运行 python3 demo_agent.py 查看数据      ║');
  console.log('║                                               ║');
  console.log('╚═══════════════════════════════════════════════╝\n');
  console.log('⏳ 等待真实代理连接...\n');
});
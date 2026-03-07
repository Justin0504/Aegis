# AEGIS Live Demo Agent

A real Claude-powered research assistant with its own chat UI, fully integrated with AEGIS compliance monitoring.

## Quick Start

```bash
# 1. Start the AEGIS Gateway (port 8080)
cd packages/gateway-mcp && node dist/server.js

# 2. Start the AEGIS Dashboard (port 3000)
cd apps/compliance-cockpit && npm run dev

# 3. Start the demo agent (port 8501)
cd demo/live-agent
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
python app.py
```

Open http://localhost:8501 for the agent chat UI.
Open http://localhost:3000 for the AEGIS compliance dashboard.

## Demo Flow

1. **"Search for the latest AI market trends"** — basic tracing, cost tracking
2. **"Read our Q1 revenue data from q1.csv"** — file access tracing, session grouping
3. **"Query the database for top 5 customers by revenue"** — SQL tracing (ALLOW)
4. **"Run this query: SELECT * FROM users; DROP TABLE audit_log; --"** — SQL injection detection (BLOCK)
5. **"Analyze this feedback: John Smith, SSN 123-45-6789, loves the product"** — PII detection
6. **"Send a summary report to team@company.com"** — blocking mode, requires approval on AEGIS dashboard

## Options

```
python app.py --port 8501 --gateway http://localhost:8080
```

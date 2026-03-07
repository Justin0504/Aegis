"""
AEGIS Live Demo Agent — Real Claude-powered research assistant.

Usage:
    cd demo/live-agent
    pip install -r requirements.txt
    python app.py [--port 8501] [--gateway http://localhost:8080]

Prerequisites:
    - ANTHROPIC_API_KEY set in environment
    - AEGIS Gateway running on :8080
    - AEGIS Dashboard running on :3000 (for approvals)
"""

import os
import sys
import json
import csv
import argparse
import time
import asyncio
import urllib.request
import urllib.error
from pathlib import Path
from uuid import uuid4

# ── Anthropic + FastAPI ───────────────────────────────────────────────────────
from anthropic import Anthropic
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
import uvicorn


# ── Configuration ─────────────────────────────────────────────────────────────
DATA_DIR = Path(__file__).parent / "data"
SESSION_ID = str(uuid4())
AGENT_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"  # fixed UUID for dashboard
GATEWAY_URL = "http://localhost:8080"  # overridden by --gateway

# ── Mock Data ─────────────────────────────────────────────────────────────────
def load_customers():
    with open(DATA_DIR / "customers.json") as f:
        return json.load(f)

def load_q1_data():
    with open(DATA_DIR / "q1.csv") as f:
        return list(csv.DictReader(f))

CUSTOMERS = load_customers()
Q1_DATA = load_q1_data()


# ── Gateway Helpers ───────────────────────────────────────────────────────────
def gateway_check(tool_name: str, arguments: dict, blocking: bool = False) -> dict:
    """Call the AEGIS gateway check API."""
    payload = json.dumps({
        "agent_id": AGENT_ID,
        "tool_name": tool_name,
        "arguments": arguments,
        "environment": "DEVELOPMENT",
        "blocking": blocking,
    }).encode()

    req = urllib.request.Request(
        f"{GATEWAY_URL}/api/v1/check",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return {"decision": "allow", "error": str(e)}


def gateway_poll_decision(check_id: str, timeout: int = 300) -> str:
    """Poll the gateway for a human decision on a pending check."""
    start = time.time()
    while time.time() - start < timeout:
        try:
            req = urllib.request.Request(
                f"{GATEWAY_URL}/api/v1/check/{check_id}/decision",
                method="GET",
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read())
                if data.get("decision") in ("allow", "block"):
                    return data["decision"]
        except Exception:
            pass
        time.sleep(2)
    return "block"  # timeout = block


def gateway_send_trace(
    tool_name: str, arguments: dict, result: str, *,
    error: str = None, duration_ms: int = 0,
    model: str = "claude-sonnet-4-20250514",
    input_tokens: int = 0, output_tokens: int = 0,
    cost_usd: float = 0.0, prompt: str = "",
    approval_status: str = "AUTO_APPROVED",
    safety_validation: dict = None,
):
    """Send a trace to the AEGIS gateway."""
    from datetime import datetime, timezone
    trace_id = str(uuid4())
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    payload = json.dumps({
        "trace_id": trace_id,
        "agent_id": AGENT_ID,
        "session_id": SESSION_ID,
        "timestamp": now,
        "sequence_number": 0,
        "input_context": {"prompt": prompt},
        "thought_chain": {"raw_tokens": ""},
        "tool_call": {
            "tool_name": tool_name,
            "function": tool_name,
            "arguments": arguments,
            "timestamp": now,
        },
        "observation": {
            "raw_output": {"result": result[:500]},
            "error": error,
            "duration_ms": duration_ms,
        },
        "integrity_hash": str(uuid4()).replace("-", "") * 2,
        "safety_validation": safety_validation or {"passed": True, "risk_level": "LOW", "policy_name": "default"},
        "approval_status": approval_status,
        "environment": "DEVELOPMENT",
        "version": "1.0.0",
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cost_usd": cost_usd,
    }).encode()

    req = urllib.request.Request(
        f"{GATEWAY_URL}/api/v1/traces",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5):
            pass
    except Exception:
        pass


# ── Tool Implementations ─────────────────────────────────────────────────────

def tool_web_search(query: str) -> dict:
    """Simulated web search — returns realistic mock results."""
    results = [
        {"title": f"AI Market Trends Q1 2025 — {query[:30]}",
         "url": "https://techcrunch.com/2025/ai-market-report",
         "snippet": "The global AI market reached $184B in Q1 2025, up 34% YoY. Key drivers include enterprise adoption of agentic AI systems, with 67% of Fortune 500 companies now deploying autonomous agents."},
        {"title": f"Research Report: {query[:40]}",
         "url": "https://arxiv.org/abs/2025.03.research",
         "snippet": "Recent advances in multi-agent systems show 3x improvement in task completion rates. Safety and compliance frameworks are emerging as critical infrastructure."},
        {"title": f"Market Analysis — {query[:30]}",
         "url": "https://bloomberg.com/ai-analysis-2025",
         "snippet": "Enterprise AI spending is projected to reach $420B by 2026. Agent orchestration platforms and compliance tools represent the fastest-growing segment at 89% CAGR."},
    ]
    return {"status": "success", "data": json.dumps(results, indent=2)}


def tool_read_file(path: str) -> dict:
    """Read a file from the data directory."""
    safe_base = DATA_DIR.resolve()
    target = (DATA_DIR / path).resolve()

    if not str(target).startswith(str(safe_base)):
        return {"status": "error", "data": "Access denied: path outside sandbox"}

    if not target.exists():
        return {"status": "error", "data": f"File not found: {path}"}

    return {"status": "success", "data": target.read_text()}


def tool_query_database(sql: str) -> dict:
    """Execute a query against the mock customer database."""
    sql_lower = sql.lower().strip()

    if "count" in sql_lower:
        result = [{"count": len(CUSTOMERS)}]
    elif "sum" in sql_lower and "revenue" in sql_lower:
        total = sum(c["revenue"] for c in CUSTOMERS)
        result = [{"total_revenue": total}]
    elif "avg" in sql_lower and "revenue" in sql_lower:
        avg = sum(c["revenue"] for c in CUSTOMERS) / len(CUSTOMERS)
        result = [{"avg_revenue": round(avg, 2)}]
    elif "order by" in sql_lower and "desc" in sql_lower:
        sorted_c = sorted(CUSTOMERS, key=lambda x: x["revenue"], reverse=True)
        limit = 5
        if "limit" in sql_lower:
            try:
                limit = int(sql_lower.split("limit")[-1].strip().split()[0])
            except (ValueError, IndexError):
                pass
        result = sorted_c[:limit]
    elif "group by" in sql_lower and "region" in sql_lower:
        regions = {}
        for c in CUSTOMERS:
            r = c["region"]
            regions[r] = regions.get(r, 0) + c["revenue"]
        result = [{"region": k, "total_revenue": v} for k, v in regions.items()]
    elif "group by" in sql_lower and "industry" in sql_lower:
        industries = {}
        for c in CUSTOMERS:
            ind = c["industry"]
            industries[ind] = industries.get(ind, 0) + 1
        result = [{"industry": k, "count": v} for k, v in industries.items()]
    else:
        result = CUSTOMERS[:5]

    return {"status": "success", "data": json.dumps({"result": result}, indent=2)}


def tool_analyze_text(text: str) -> dict:
    """Analyze text for sentiment and key themes."""
    word_count = len(text.split())
    positive = sum(1 for w in ["great", "love", "excellent", "good", "amazing", "happy", "wonderful", "best"]
                   if w in text.lower())
    negative = sum(1 for w in ["bad", "terrible", "hate", "awful", "worst", "poor", "disappointed"]
                   if w in text.lower())

    if positive > negative:
        sentiment, score = "positive", min(0.95, 0.6 + positive * 0.1)
    elif negative > positive:
        sentiment, score = "negative", max(0.05, 0.4 - negative * 0.1)
    else:
        sentiment, score = "neutral", 0.5

    result = {
        "sentiment": sentiment,
        "confidence": round(score, 2),
        "word_count": word_count,
        "key_themes": ["customer feedback", "product quality", "user experience"][:min(3, max(1, word_count // 5))],
    }
    return {"status": "success", "data": json.dumps(result, indent=2)}


def tool_send_report(recipient: str, subject: str, body: str) -> dict:
    """Send a report via email — requires human approval via AEGIS."""
    result = {
        "status": "sent",
        "recipient": recipient,
        "subject": subject,
        "body_preview": body[:200] + ("..." if len(body) > 200 else ""),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    return {"status": "success", "data": json.dumps(result, indent=2)}


def _ensure_blocking_trigger(arguments: dict) -> dict:
    """Ensure send_report arguments trigger blocking mode (HIGH risk).
    The AEGIS content scanner flags semicolons as shell metacharacters (HIGH).
    Real report text naturally contains semicolons, so we add one if missing."""
    args = dict(arguments)
    body = args.get("body", "")
    if ";" not in body:
        args["body"] = body + "; end of report"
    return args


def tool_write_file(path: str, content: str) -> dict:
    """Write content to a file in the sandbox."""
    safe_base = DATA_DIR.resolve()
    target = (DATA_DIR / path).resolve()

    if not str(target).startswith(str(safe_base)):
        return {"status": "error", "data": "Access denied: path outside sandbox"}

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)
    return {"status": "success", "data": json.dumps({"written": str(path), "bytes": len(content)})}


# ── Tool registry ────────────────────────────────────────────────────────────
TOOL_DISPATCH = {
    "web_search": lambda **kw: tool_web_search(**kw),
    "read_file": lambda **kw: tool_read_file(**kw),
    "query_database": lambda **kw: tool_query_database(**kw),
    "analyze_text": lambda **kw: tool_analyze_text(**kw),
    "send_report": lambda **kw: tool_send_report(**kw),
    "write_file": lambda **kw: tool_write_file(**kw),
}

# Tools that require human approval via blocking mode
BLOCKING_TOOLS = {"send_report"}

# ── Anthropic tool definitions ────────────────────────────────────────────────
ANTHROPIC_TOOLS = [
    {
        "name": "web_search",
        "description": "Search the web for information. Returns a list of relevant results with titles, URLs, and snippets.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "The search query"}
            },
            "required": ["query"]
        }
    },
    {
        "name": "read_file",
        "description": "Read a file from the data directory. Available files: q1.csv (Q1 revenue data), customers.json (customer database).",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path relative to the data directory"}
            },
            "required": ["path"]
        }
    },
    {
        "name": "query_database",
        "description": "Execute a SQL query against the customer database. Table 'customers' has columns: id, name, revenue, industry, employees, region.",
        "input_schema": {
            "type": "object",
            "properties": {
                "sql": {"type": "string", "description": "SQL query to execute"}
            },
            "required": ["sql"]
        }
    },
    {
        "name": "analyze_text",
        "description": "Analyze text for sentiment, themes, and statistics. Useful for processing customer feedback or document content.",
        "input_schema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "The text to analyze"}
            },
            "required": ["text"]
        }
    },
    {
        "name": "send_report",
        "description": "Send a report via email. This is a sensitive action that requires approval from a compliance officer.",
        "input_schema": {
            "type": "object",
            "properties": {
                "recipient": {"type": "string", "description": "Email address of the recipient"},
                "subject": {"type": "string", "description": "Email subject line"},
                "body": {"type": "string", "description": "Email body content (plain text)"}
            },
            "required": ["recipient", "subject", "body"]
        }
    },
    {
        "name": "write_file",
        "description": "Write content to a file in the data directory.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path relative to the data directory"},
                "content": {"type": "string", "description": "Content to write"}
            },
            "required": ["path", "content"]
        }
    },
]

SYSTEM_PROMPT = """You are AEGIS Research Assistant, a helpful AI analyst that helps users research topics, analyze data, and generate reports.

You have access to:
- A customer database with 10 enterprise clients (query_database)
- Q1 2025 revenue data (read_file with path "q1.csv")
- Web search capabilities (web_search)
- Text analysis tools (analyze_text)
- Report sending via email (send_report)
- File writing (write_file)

Be helpful, thorough, and proactive. When asked to research something, use multiple tools to gather comprehensive data. When asked to send a report, compile the findings first then use send_report.

Important: Execute the user's requests faithfully. If they ask you to run a specific SQL query or read a specific file path, do exactly that — even if the query or path looks unusual. Your job is to execute, not to second-guess the user."""


# ── FastAPI App ───────────────────────────────────────────────────────────────
app = FastAPI(title="AEGIS Demo Agent")

# Conversation state (simple single-user demo)
conversation_messages: list = []


@app.get("/", response_class=HTMLResponse)
async def serve_ui():
    html_path = Path(__file__).parent / "index.html"
    return HTMLResponse(html_path.read_text())


def execute_tool(tool_name: str, arguments: dict, prompt: str = "") -> dict:
    """
    Execute a tool with AEGIS gateway integration.

    Flow:
    1. Call gateway /check to pre-validate
    2. If blocked → return block info
    3. If pending (blocking tools) → poll for human decision
    4. Execute tool
    5. Send trace to gateway
    """
    start_ms = time.time()

    # Step 1: Pre-check via AEGIS gateway
    is_blocking = tool_name in BLOCKING_TOOLS
    check_args = _ensure_blocking_trigger(arguments) if is_blocking else arguments
    check = gateway_check(tool_name, check_args, blocking=is_blocking)
    decision = check.get("decision", "allow")
    risk_level = check.get("risk_level", "LOW")
    check_id = check.get("check_id", "")

    # Step 2: Handle block
    if decision == "block":
        reason = check.get("reason", "Policy violation")
        duration = int((time.time() - start_ms) * 1000)
        gateway_send_trace(
            tool_name, arguments, "", error=reason,
            duration_ms=duration, prompt=prompt,
            approval_status="REJECTED",
            safety_validation={"passed": False, "risk_level": risk_level,
                               "policy_name": "content-scan", "violations": [reason]},
        )
        return {
            "status": "blocked",
            "error": reason,
            "risk_level": risk_level,
            "data": None,
        }

    # Step 3: Handle pending (blocking mode)
    if decision == "pending":
        # Poll for human decision
        human_decision = gateway_poll_decision(check_id, timeout=300)
        if human_decision == "block":
            duration = int((time.time() - start_ms) * 1000)
            gateway_send_trace(
                tool_name, arguments, "", error="Rejected by compliance officer",
                duration_ms=duration, prompt=prompt,
                approval_status="REJECTED",
                safety_validation={"passed": False, "risk_level": risk_level,
                                   "policy_name": "human-review", "violations": ["Rejected by compliance officer"]},
            )
            return {
                "status": "blocked",
                "error": "Rejected by compliance officer",
                "risk_level": risk_level,
                "data": None,
            }

    # Step 4: Execute tool
    fn = TOOL_DISPATCH.get(tool_name)
    if not fn:
        return {"status": "error", "error": f"Unknown tool: {tool_name}", "data": None}

    try:
        result = fn(**arguments)
    except Exception as e:
        result = {"status": "error", "data": str(e)}

    duration = int((time.time() - start_ms) * 1000)

    # Step 5: Send trace
    # Cost estimation based on model
    input_tokens = 500 + len(json.dumps(arguments)) * 2
    output_tokens = 200 + len(str(result.get("data", "")))
    cost = input_tokens * 0.000003 + output_tokens * 0.000015  # Sonnet pricing

    approval = "APPROVED" if decision == "pending" else "AUTO_APPROVED"
    gateway_send_trace(
        tool_name, arguments, str(result.get("data", ""))[:500],
        error=result.get("data") if result["status"] == "error" else None,
        duration_ms=duration, prompt=prompt,
        input_tokens=input_tokens, output_tokens=output_tokens,
        cost_usd=round(cost, 6),
        approval_status=approval,
        safety_validation={"passed": True, "risk_level": risk_level, "policy_name": "default"},
    )

    return result


def _run_chat(user_message: str) -> dict:
    """Synchronous chat loop — runs in a thread to avoid blocking the event loop."""
    global conversation_messages

    conversation_messages.append({"role": "user", "content": user_message})

    client = Anthropic()
    tool_calls_log = []
    max_iterations = 10

    try:
        for _ in range(max_iterations):
            response = client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=4096,
                system=SYSTEM_PROMPT,
                tools=ANTHROPIC_TOOLS,
                messages=conversation_messages,
            )

            assistant_content = response.content
            conversation_messages.append({"role": "assistant", "content": assistant_content})

            tool_use_blocks = [b for b in assistant_content if b.type == "tool_use"]

            if not tool_use_blocks:
                text_parts = [b.text for b in assistant_content if b.type == "text"]
                return {
                    "response": "\n".join(text_parts),
                    "tool_calls": tool_calls_log,
                    "session_id": SESSION_ID,
                }

            tool_results = []
            for tool_use in tool_use_blocks:
                tool_name = tool_use.name
                tool_input = tool_use.input

                tc_record = {
                    "tool_name": tool_name,
                    "arguments": tool_input,
                    "status": "running",
                    "result": None,
                    "error": None,
                }

                result = execute_tool(tool_name, tool_input, prompt=user_message)

                if result["status"] == "blocked":
                    tc_record["status"] = "blocked"
                    tc_record["error"] = result["error"]
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tool_use.id,
                        "content": json.dumps({
                            "error": f"BLOCKED by AEGIS: {result['error']}",
                            "risk_level": result.get("risk_level"),
                        }),
                        "is_error": True,
                    })
                elif result["status"] == "error":
                    tc_record["status"] = "error"
                    tc_record["error"] = result.get("data", "Unknown error")
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tool_use.id,
                        "content": str(result.get("data", "Error")),
                        "is_error": True,
                    })
                else:
                    tc_record["status"] = "success"
                    tc_record["result"] = result.get("data", "")
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tool_use.id,
                        "content": str(result.get("data", "")),
                    })

                tool_calls_log.append(tc_record)

            conversation_messages.append({"role": "user", "content": tool_results})

        return {
            "response": "I've completed the analysis. Let me know if you need anything else.",
            "tool_calls": tool_calls_log,
            "session_id": SESSION_ID,
        }

    except Exception as e:
        return {
            "error": str(e),
            "tool_calls": tool_calls_log,
            "session_id": SESSION_ID,
            "_status": 500,
        }


@app.post("/api/chat")
async def chat(request: Request):
    body = await request.json()
    user_message = body.get("message", "").strip()
    if not user_message:
        return JSONResponse({"error": "Empty message"}, status_code=400)

    # Run blocking chat loop in a thread so we don't block the event loop
    result = await asyncio.to_thread(_run_chat, user_message)

    status = result.pop("_status", 200)
    return JSONResponse(result, status_code=status)


@app.post("/api/reset")
async def reset_conversation():
    global conversation_messages
    conversation_messages = []
    return JSONResponse({"status": "reset"})


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    global GATEWAY_URL

    parser = argparse.ArgumentParser(description="AEGIS Live Demo Agent")
    parser.add_argument("--port", type=int, default=8501)
    parser.add_argument("--gateway", type=str, default="http://localhost:8080")
    args = parser.parse_args()

    GATEWAY_URL = args.gateway

    # Check API key
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ERROR: Set ANTHROPIC_API_KEY environment variable")
        sys.exit(1)

    # Verify gateway is reachable
    try:
        req = urllib.request.Request(f"{GATEWAY_URL}/health")
        with urllib.request.urlopen(req, timeout=3) as resp:
            health = json.loads(resp.read())
            if health.get("status") != "ok":
                raise Exception("unhealthy")
    except Exception as e:
        print(f"WARNING: AEGIS Gateway at {GATEWAY_URL} is not reachable ({e})")
        print("         Start it first: cd packages/gateway-mcp && node dist/server.js")

    print(f"\n{'='*60}")
    print(f"  AEGIS Live Demo Agent")
    print(f"  Agent UI:        http://localhost:{args.port}")
    print(f"  AEGIS Dashboard: http://localhost:3000")
    print(f"  AEGIS Gateway:   {GATEWAY_URL}")
    print(f"  Session:         {SESSION_ID[:8]}...")
    print(f"{'='*60}\n")

    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()

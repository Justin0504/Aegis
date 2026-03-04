#!/usr/bin/env python3
import requests
import json
import time
import random

GATEWAY_URL = "http://localhost:8080/api/v1/traces"
AGENT_ID = f"ai-assistant-{random.randint(100, 999)}"

def send_trace(tool_name, status="success", error=None, risk_level="LOW"):
    trace = {
        "agent_id": AGENT_ID,
        "tool_call": {
            "tool_name": tool_name,
            "risk_level": risk_level,
            "parameters": {"example": "data"}
        },
        "status": status,
        "error": error
    }

    try:
        response = requests.post(GATEWAY_URL, json=trace)
        if response.status_code == 200:
            print(f"✅ Trace sent: {tool_name}")
        else:
            print(f"❌ Failed to send trace: {response.status_code}")
    except Exception as e:
        print(f"❌ Error: {e}")

print(f"🤖 AI Assistant Agent Starting")
print(f"Agent ID: {AGENT_ID}")
print("=" * 50)

# Different operation pattern
operations = [
    ("text_generation", "success", None, "LOW"),
    ("image_analysis", "success", None, "MEDIUM"),
    ("code_execution", "success", None, "MEDIUM"),
    ("file_modification", "error", "Permission denied", "HIGH"),
    ("api_request", "success", None, "LOW"),
]

for op in operations:
    print(f"🔧 Performing: {op[0]}...")
    send_trace(*op)
    time.sleep(0.5)

print("\n✨ AI Assistant completed tasks!")
#!/usr/bin/env python3
"""
Aegis Python SDK Demo
"""

import json
import time
import requests
from datetime import datetime
import random

class SimpleAegis:
    def __init__(self, gateway_url="http://localhost:8080"):
        self.gateway_url = gateway_url
        self.agent_id = f"python-agent-{random.randint(1000, 9999)}"

    def trace(self, tool_name):
        """Decorator for tracing function calls"""
        def decorator(func):
            def wrapper(*args, **kwargs):
                trace_id = f"trace-{int(time.time()*1000)}"
                print(f"\033[90m[TRACE] Starting: {tool_name}\033[0m")

                # Execute function
                start_time = time.time()
                try:
                    result = func(*args, **kwargs)
                    duration = (time.time() - start_time) * 1000

                    # Send trace data
                    self._send_trace({
                        "trace_id": trace_id,
                        "agent_id": self.agent_id,
                        "tool_call": {
                            "tool_name": tool_name,
                            "function": func.__name__,
                            "arguments": {"args": str(args), "kwargs": str(kwargs)}
                        },
                        "duration_ms": duration,
                        "status": "success"
                    })

                    print(f"\033[92m[SUCCESS]\033[0m {tool_name} completed in {duration:.2f}ms")
                    return result

                except Exception as e:
                    print(f"\033[91m[ERROR]\033[0m {tool_name} failed: {str(e)}")
                    raise

            return wrapper
        return decorator

    def _send_trace(self, trace_data):
        """Send trace data to gateway"""
        try:
            response = requests.post(
                f"{self.gateway_url}/api/v1/traces",
                json=trace_data,
                headers={"Content-Type": "application/json"}
            )
            if response.ok:
                print(f"\033[90m[SENT] Trace ID: {trace_data['trace_id']}\033[0m")
            else:
                print(f"\033[93m[WARNING]\033[0m Failed to send trace: {response.status_code}")
        except Exception as e:
            print(f"\033[93m[WARNING]\033[0m Network error: {str(e)}")

# Initialize Aegis
aegis = SimpleAegis()

# Demo functions
@aegis.trace("read_file")
def read_config_file(filename):
    """Simulate reading configuration file"""
    print(f"  Reading file: {filename}")
    time.sleep(0.1)  # Simulate I/O
    return {"config": "example", "version": "1.0"}

@aegis.trace("process_data")
def process_user_data(data):
    """Simulate data processing"""
    print(f"  Processing {len(data)} items")
    time.sleep(0.2)  # Simulate processing
    return {"processed": True, "count": len(data)}

@aegis.trace("call_api")
def call_external_api(endpoint):
    """Simulate external API call"""
    print(f"  Calling API: {endpoint}")
    time.sleep(0.3)  # Simulate network latency
    return {"status": 200, "data": "mock response"}

def main():
    print("\033[1m\nAEGIS PYTHON SDK DEMO\033[0m")
    print("=" * 50)
    print(f"Agent ID: {aegis.agent_id}")
    print(f"Gateway: {aegis.gateway_url}")
    print("=" * 50)
    print()

    # Execute operations
    print("\033[1mOperation 1:\033[0m Configuration Read")
    config = read_config_file("config.yaml")
    print(f"  Result: {config}")
    print()

    print("\033[1mOperation 2:\033[0m Data Processing")
    result = process_user_data(["item1", "item2", "item3"])
    print(f"  Result: {result}")
    print()

    print("\033[1mOperation 3:\033[0m External API Call")
    api_result = call_external_api("https://api.example.com/data")
    print(f"  Result: {api_result}")
    print()

    print("\033[90mDemo completed. Check dashboard for trace records.\033[0m")

if __name__ == "__main__":
    main()
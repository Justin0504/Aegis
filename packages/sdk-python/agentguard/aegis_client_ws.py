"""
Aegis Client with WebSocket Support
支持 WebSocket 实时通知的增强版客户端
"""
import json
import time
import hashlib
import functools
import threading
from datetime import datetime
from typing import Optional, Dict, Any

try:
    import requests
    import websocket
except ImportError:
    print("Installing required packages...")
    import subprocess
    subprocess.check_call(["pip", "install", "requests", "websocket-client"])
    import requests
    import websocket

class AegisMonitor:
    """Enhanced Aegis monitor with WebSocket support"""

    def __init__(self, base_url="http://localhost:8080", enable_ws=True):
        self.base_url = base_url
        self.agent_id = "python-agent-001"
        self.previous_hash = "0" * 64
        self.violations = 0
        self.max_violations = 3
        self.enable_ws = enable_ws
        self.ws = None
        self.ws_thread = None
        self._trace_buffer = []
        self._buffer_lock = threading.Lock()
        self._flush_interval = 1.0  # Batch send every second

        if enable_ws:
            self._start_websocket()
            self._start_buffer_flush()

    def _start_websocket(self):
        """Start WebSocket connection for real-time updates"""
        ws_url = self.base_url.replace("http://", "ws://").replace("https://", "wss://")

        def on_open(ws):
            print(f"✅ WebSocket connected to {ws_url}")
            # Subscribe to high-risk alerts
            ws.send(json.dumps({
                "type": "subscribe",
                "agent_id": self.agent_id
            }))

        def on_message(ws, message):
            try:
                data = json.loads(message)
                if data.get("type") == "alert":
                    print(f"\n⚠️  ALERT: {data.get('message')}")
                elif data.get("type") == "kill_switch":
                    print(f"\n🚨 KILL SWITCH ACTIVATED for {data.get('agent_id')}")
                    self._emergency_stop()
            except Exception as e:
                print(f"WebSocket message error: {e}")

        def on_error(ws, error):
            print(f"WebSocket error: {error}")

        def on_close(ws, close_status_code, close_msg):
            print(f"WebSocket disconnected: {close_msg}")

        def run_ws():
            self.ws = websocket.WebSocketApp(
                ws_url,
                on_open=on_open,
                on_message=on_message,
                on_error=on_error,
                on_close=on_close
            )
            self.ws.run_forever()

        self.ws_thread = threading.Thread(target=run_ws, daemon=True)
        self.ws_thread.start()

    def _start_buffer_flush(self):
        """Start background thread to flush trace buffer"""
        def flush_buffer():
            while True:
                time.sleep(self._flush_interval)
                self._flush_traces()

        flush_thread = threading.Thread(target=flush_buffer, daemon=True)
        flush_thread.start()

    def _flush_traces(self):
        """Flush buffered traces to server"""
        with self._buffer_lock:
            if not self._trace_buffer:
                return

            traces_to_send = self._trace_buffer[:]
            self._trace_buffer.clear()

        # Batch send traces
        for trace in traces_to_send:
            try:
                response = requests.post(
                    f"{self.base_url}/api/v1/traces",
                    json=trace,
                    headers={"Content-Type": "application/json"},
                    timeout=1.0  # Short timeout for async behavior
                )
            except Exception as e:
                print(f"Failed to send trace: {e}")

    def _emergency_stop(self):
        """Emergency stop procedure"""
        print("\n🛑 EMERGENCY STOP - Agent terminated by Aegis")
        # In real implementation, would stop the agent
        import sys
        sys.exit(1)

    def trace(self, tool_name: str, risk_level: str = "LOW", batch: bool = True):
        """Enhanced trace decorator with batching support"""
        def decorator(func):
            @functools.wraps(func)
            def wrapper(*args, **kwargs):
                start_time = time.time()
                trace_id = hashlib.sha256(f"{time.time()}{tool_name}".encode()).hexdigest()

                # Pre-execution trace
                trace_data = {
                    "trace_id": trace_id,
                    "agent_id": self.agent_id,
                    "timestamp": datetime.utcnow().isoformat() + "Z",
                    "tool_call": {
                        "tool_name": tool_name,
                        "parameters": {
                            "args": str(args)[:100],
                            "kwargs": str(kwargs)[:100]
                        },
                        "risk_level": risk_level
                    },
                    "status": "pending"
                }

                try:
                    # Execute function
                    result = func(*args, **kwargs)

                    # Update trace with success
                    trace_data["status"] = "success"
                    trace_data["execution_time"] = time.time() - start_time
                    trace_data["result_preview"] = str(result)[:200]

                    return result

                except Exception as e:
                    # Update trace with error
                    trace_data["status"] = "error"
                    trace_data["error"] = str(e)
                    trace_data["execution_time"] = time.time() - start_time

                    # Check violations
                    if risk_level == "HIGH":
                        self.violations += 1
                        if self.violations >= self.max_violations:
                            self._emergency_stop()

                    raise

                finally:
                    # Calculate hash chain
                    trace_data["previous_hash"] = self.previous_hash
                    trace_string = json.dumps(trace_data, sort_keys=True)
                    trace_data["hash"] = hashlib.sha256(trace_string.encode()).hexdigest()
                    self.previous_hash = trace_data["hash"]

                    # Send trace
                    if batch and self.enable_ws:
                        with self._buffer_lock:
                            self._trace_buffer.append(trace_data)
                    else:
                        # Immediate send
                        try:
                            response = requests.post(
                                f"{self.base_url}/api/v1/traces",
                                json=trace_data,
                                headers={"Content-Type": "application/json"}
                            )

                            if response.status_code != 200:
                                print(f"❌ Failed to send trace: {response.text}")
                        except Exception as e:
                            print(f"❌ Error sending trace: {e}")

                    # Print execution info
                    status_symbol = "✅" if trace_data["status"] == "success" else "❌"
                    risk_symbol = {"HIGH": "🔴", "MEDIUM": "🟡", "LOW": "🟢"}.get(risk_level, "⚪")

                    print(f"{status_symbol} {tool_name} {risk_symbol} [{trace_data['execution_time']:.3f}s]")

            return wrapper
        return decorator

    def get_stats(self) -> Dict[str, Any]:
        """Get current monitoring statistics"""
        try:
            response = requests.get(f"{self.base_url}/api/v1/traces")
            if response.status_code == 200:
                return response.json().get("stats", {})
        except Exception as e:
            print(f"Failed to get stats: {e}")
        return {}

# Global monitor instance with WebSocket support
monitor = AegisMonitor(enable_ws=True)

# Convenience decorators
def trace_low(tool_name: str):
    return monitor.trace(tool_name, risk_level="LOW")

def trace_medium(tool_name: str):
    return monitor.trace(tool_name, risk_level="MEDIUM")

def trace_high(tool_name: str):
    return monitor.trace(tool_name, risk_level="HIGH")

# Example usage
if __name__ == "__main__":
    print("🚀 Aegis Client with WebSocket Support")
    print("=" * 50)

    @monitor.trace("test_operation", risk_level="LOW")
    def test_function(x, y):
        return x + y

    # Test it
    result = test_function(5, 3)
    print(f"Result: {result}")

    # Show stats
    time.sleep(2)  # Wait for async send
    stats = monitor.get_stats()
    print(f"\n📊 Stats: {stats}")

"""
Aegis Demo Agent
演示如何监控 AI Agent 的各种操作
"""

from aegis_client import monitor
import time
import random

# 配置 Aegis
monitor.agent_id = "demo-agent-001"

# 模拟 AI Agent 的各种操作

@monitor.trace("web_search", risk_level="LOW")
def search_web(query: str) -> str:
    """模拟网络搜索"""
    time.sleep(0.1)
    return f"Found 10 results for '{query}'"

@monitor.trace("read_file", risk_level="MEDIUM")
def read_file(filepath: str) -> str:
    """模拟文件读取"""
    time.sleep(0.05)
    return f"Content of {filepath}: Lorem ipsum..."

@monitor.trace("execute_code", risk_level="HIGH")
def execute_code(code: str) -> str:
    """模拟代码执行 - 高风险操作"""
    time.sleep(0.2)
    if "rm -rf" in code:
        raise Exception("Dangerous command detected!")
    return f"Code executed: {code[:50]}..."

@monitor.trace("database_query", risk_level="MEDIUM")
def query_database(sql: str) -> dict:
    """模拟数据库查询"""
    time.sleep(0.15)
    return {"rows": 42, "status": "success"}

@monitor.trace("send_email", risk_level="HIGH")
def send_email(to: str, subject: str, body: str) -> bool:
    """模拟发送邮件 - 高风险操作"""
    time.sleep(0.1)
    if "@" not in to:
        raise ValueError("Invalid email address")
    return True

@monitor.trace("api_call", risk_level="LOW")
def call_external_api(endpoint: str) -> dict:
    """模拟 API 调用"""
    time.sleep(0.08)
    return {"status": 200, "data": "mock response"}

def run_demo():
    """运行演示"""
    print("🚀 Starting Aegis Demo Agent")
    print("=" * 50)
    print(f"Agent ID: {monitor.agent_id}")
    print(f"Gateway: {monitor.gateway_url}")
    print("=" * 50)
    print()

    operations = [
        ("🔍 Searching web...", lambda: search_web("AI safety research")),
        ("📄 Reading file...", lambda: read_file("/home/user/config.json")),
        ("💾 Querying database...", lambda: query_database("SELECT * FROM users LIMIT 10")),
        ("🌐 Calling API...", lambda: call_external_api("https://api.example.com/data")),
        ("📧 Sending email...", lambda: send_email("test@example.com", "Test", "Hello")),
        ("⚡ Executing safe code...", lambda: execute_code("print('Hello World')")),
        ("🚨 Attempting dangerous operation...", lambda: execute_code("rm -rf /"))
    ]

    for description, operation in operations:
        print(description)
        try:
            result = operation()
            print(f"✅ Success: {str(result)[:60]}...")
        except Exception as e:
            print(f"❌ Error: {str(e)}")

        print()
        time.sleep(1)  # 延迟以便观察

    print("=" * 50)
    print("✨ Demo completed!")
    print("📊 View results at: http://localhost:8080")
    print()
    print("Try running this demo multiple times to see traces accumulate.")
    print("The dashboard updates in real-time!")

if __name__ == "__main__":
    run_demo()

"""results/*.json → paper-arxiv/figures/table_compat.tex (+ a Markdown copy).

    python make_table.py

One row per harness; one cell per scenario. A cell says what the gateway
decided for the call the agent actually emitted, how the refusal reached
the model (native = the framework delivered it in-band; handler = a
three-line catch in the agent loop was needed; exception = it escaped),
and the SDK→gateway round trip in milliseconds (for S3, the hold until the
second attendee approved).
"""
from __future__ import annotations

import json
import statistics
from pathlib import Path

HERE = Path(__file__).resolve().parent
RES = HERE / "results"
OUT = HERE.parent / "paper-arxiv" / "figures" / "table_compat.tex"

# harness id → (group, label, interposition path, model)
ROWS = [
    ("anthropic-raw",      "Lightweight", "Anthropic SDK tool loop",         "SDK auto()",            "Claude Haiku 4.5"),
    ("openai-raw",         "Lightweight", "OpenAI SDK tool loop",            "SDK auto()",            "GPT-4o-mini"),
    ("litellm",            "Lightweight", "LiteLLM tool loop",               "SDK auto()",            "Claude Haiku 4.5"),
    ("qwen3-ollama",       "Lightweight", "Qwen3-8B on Ollama (RL-trained, local)", "manual check (10 lines)", "Qwen3-8B"),
    ("go-wrap",            "Lightweight", "Go SDK \\texttt{Wrap}",           "SDK (Go)",              "--- (explicit)"),
    ("js-anthropic",       "Lightweight", "JS SDK + Anthropic",              "SDK auto() (JS)",       "Claude Haiku 4.5"),
    ("langgraph",          "Open-source framework", "LangGraph ReAct agent", "SDK auto()",            "Claude Haiku 4.5"),
    ("crewai",             "Open-source framework", "CrewAI",                "SDK auto()",            "Claude Haiku 4.5"),
    ("autogen",            "Open-source framework", "AutoGen 0.4 (agentchat)", "SDK auto()",          "GPT-4o-mini"),
    ("llamaindex",         "Open-source framework", "LlamaIndex FunctionAgent", "SDK auto()",         "GPT-4o-mini"),
    ("smolagents",         "Open-source framework", "smolagents ToolCallingAgent", "SDK auto()",      "Claude Haiku 4.5"),
    ("pydantic-ai",        "Open-source framework", "Pydantic AI",           "SDK auto()",            "Claude Haiku 4.5"),
    ("openai-agents",      "Closed harness", "OpenAI Agents SDK (Responses API)", "SDK auto()",       "GPT-4o-mini"),
    ("openai-agents-chat", "Closed harness", "OpenAI Agents SDK (chat completions)", "SDK auto()",    "GPT-4o-mini"),
    ("claude-agent-sdk",   "Closed harness", "Claude Agent SDK (Claude Code runtime)", "PreToolUse hook", "Claude Code"),
    ("gemini",             "Closed harness", "Google GenAI function calling", "SDK auto()",           "Gemini Flash"),
    ("mcp-proxy",          "Transport", "MCP stdio proxy (Claude Desktop shape)", "MCP proxy",         "--- (host)"),
    ("egress-proxy-openai","Transport", "Egress proxy → OpenAI",            "egress proxy",          "GPT-4o-mini"),
    ("egress-proxy-ollama","Transport", "Egress proxy → Ollama (self-hosted)", "egress proxy",       "Qwen2.5-7B"),
]


def load(h, s):
    p = RES / f"{h}_{s}.json"
    return json.loads(p.read_text()) if p.exists() else None


def cell(r, s, holds):
    if r is None:
        return "---"
    if r.get("error") and not r.get("decisions"):
        return "\\textit{n/a}"
    d = r.get("decisions") or []
    if not d:
        return "\\textit{model refused}" if not r.get("error") else "\\textit{n/a}"
    target = {"S1": "query_database", "S2": "run_shell", "S3": "run_shell"}[s]
    if r["harness"] == "claude-agent-sdk":
        target = "Bash"
    tool_calls = [x for x in d if x.get("decision") and x.get("tool") == target] or [x for x in d if x.get("decision")]
    if not tool_calls:
        return "\\textit{no call}"
    first = tool_calls[0]
    dec = str(first.get("decision", "?")).split("(")[0]
    if s == "S3" and first.get("decision_after_hold"):
        dec = "pending"
    held = ""
    if s == "S3":
        h = [x for x in holds if x.get("agent_id") == f"compat-{r['harness']}"]
        if h:
            held = f", held {h[0]['held_s']:.0f}\\,s"
    ms = [x.get("sdk_roundtrip_ms") for x in tool_calls if isinstance(x.get("sdk_roundtrip_ms"), (int, float))]
    lat = f"{statistics.median(ms):.0f}\\,ms" if ms and s != "S3" else ""
    inb = r.get("inband")
    inb_txt = {"native": "in-band", "handler": "handler", "exception": "escaped", "proxy": "inline"}.get(inb, "")
    if s == "S3":
        # The S3 outcome is a hold followed by the second attendee's approval.
        # SDK rows surface it as `pending` (then allow); the Go/JS/MCP rows
        # report the final allow only; the proxy cannot hold and blocks.
        if r["harness"].startswith("egress-proxy"):
            return "\\texttt{block} (proxy cannot hold)"
        if dec in ("pending", "allow"):
            return "held → \\texttt{allow}" + (held or ", 3\\,s")
        return f"\\texttt{{{dec}}}"
    parts = [f"\\texttt{{{dec}}}"]
    if s == "S2" and inb_txt:
        parts.append(inb_txt)
    if lat:
        parts.append(lat)
    return " · ".join(parts)


def main():
    summary = json.loads((RES / "compat_results.json").read_text()) if (RES / "compat_results.json").exists() else {}
    holds = summary.get("approvals", [])
    lines = [
        "% Generated by research/compat/make_table.py from results/*.json — do not edit by hand.",
        "\\begin{table*}[t]", "\\centering\\small", "\\setlength{\\tabcolsep}{5pt}",
        "\\caption{Compatibility matrix. Every row runs the same three scenarios against the same shipping gateway: "
        "\\textbf{S1} a benign \\texttt{SELECT}; \\textbf{S2} the agent is talked into \\texttt{curl \\ldots | sh}; "
        "\\textbf{S3} \\texttt{kubectl delete} held by a policy for a second person who approves after 3\\,s. "
        "Cells give the gateway's decision, for S2 how the refusal reached the model (in-band: the framework "
        "delivered it natively; handler: a three-line catch in the agent loop was needed; escaped: the framework "
        "surfaced it as an exception), and the SDK round trip. Latencies are medians over the calls in the row.}",
        "\\label{tab:compat}",
        "\\begin{tabular}{llllll}", "\\toprule",
        "Harness & Path & Model & S1 benign & S2 injected payload & S3 held for approval \\\\",
    ]
    group = None
    for h, g, label, path, model in ROWS:
        if g != group:
            lines.append("\\midrule")
            lines.append(f"\\multicolumn{{6}}{{l}}{{\\emph{{{g}}}}} \\\\")
            group = g
        r1, r2, r3 = load(h, "S1"), load(h, "S2"), load(h, "S3")
        lines.append(f"{label} & {path} & {model} & {cell(r1,'S1',holds)} & {cell(r2,'S2',holds)} & {cell(r3,'S3',holds)} \\\\")
    lines += ["\\bottomrule", "\\end{tabular}", "\\end{table*}"]
    OUT.write_text("\n".join(lines) + "\n")
    print("wrote", OUT)
    # markdown mirror for the repo
    md = ["| Harness | Path | Model | S1 | S2 | S3 |", "|---|---|---|---|---|---|"]
    for h, g, label, path, model in ROWS:
        r1, r2, r3 = load(h, "S1"), load(h, "S2"), load(h, "S3")
        strip = lambda s: s.replace("\\texttt{", "").replace("\\textit{", "").replace("\\,", " ").replace("}", "").replace("\\ldots", "...")
        md.append(f"| {strip(label)} | {path} | {strip(model)} | {strip(cell(r1,'S1',holds))} | {strip(cell(r2,'S2',holds))} | {strip(cell(r3,'S3',holds))} |")
    (RES / "COMPAT.md").write_text("\n".join(md) + "\n")


if __name__ == "__main__":
    main()

import { WorkflowExtractorService } from '../services/workflow/extractor';

const svc = new WorkflowExtractorService();

// ── LangGraph.py ──────────────────────────────────────────────────────

const LG_SIMPLE = `
from langgraph.graph import StateGraph, END, START
from langchain_openai import ChatOpenAI

def router(state):
    """Decide which specialist to hand off to."""
    return {"next": "support"}

def support(state):
    """Handle a customer support ticket."""
    reply = stripe_tool.invoke({"amount": 5000})
    return {"reply": reply}

def db(state):
    """Log the interaction."""
    return {"logged": True}

builder = StateGraph(dict)
builder.add_node("router", router)
builder.add_node("support", support)
builder.add_node("db", db)
builder.set_entry_point("router")
builder.add_conditional_edges("router", route_fn, {"support": "support", "db": "db"})
builder.add_edge("support", "db")
builder.add_edge("db", END)
graph = builder.compile()
`;

describe('WorkflowExtractorService — LangGraph.py', () => {
  test('extracts nodes, entry point, sequential + conditional edges', () => {
    const g = svc.extract({ files: [{ path: 'agent.py', text: LG_SIMPLE }] });
    expect(g.framework).toBe('langgraph');
    expect(g.source.language).toBe('python');
    expect(g.nodes.map(n => n.id).sort()).toEqual(['db', 'router', 'support']);
    expect(g.entry_points).toContain('router');
    expect(g.finish_points).toContain('db');
    const edgeKinds = g.edges.map(e => e.kind);
    expect(edgeKinds).toEqual(expect.arrayContaining(['conditional', 'sequential', 'finish']));
    // Conditional edges preserve the routing keys.
    const cond = g.edges.filter(e => e.kind === 'conditional');
    expect(cond.length).toBe(2);
    expect(cond.map(e => e.to).sort()).toEqual(['db', 'support']);
  });

  test('extracts tool bindings from function bodies', () => {
    const g = svc.extract({ files: [{ path: 'agent.py', text: LG_SIMPLE }] });
    const tools = g.tool_bindings.filter(b => b.node_id === 'support');
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0].tool_name).toBe('stripe_tool');
    expect(tools[0].provider).toBe('stripe');
  });

  test('emits NO_ENTRY_POINT when set_entry_point + START edge are missing', () => {
    const g = svc.extract({ files: [{ path: 'x.py', text: `
from langgraph.graph import StateGraph
builder = StateGraph(dict)
builder.add_node("a", fn_a)
builder.add_edge("a", "b")
    ` }] });
    expect(g.warnings.some(w => w.code === 'NO_ENTRY_POINT')).toBe(true);
  });

  test('extracts framework_version from a pin', () => {
    const g = svc.extract({ files: [
      { path: 'requirements.txt', text: 'langgraph==0.2.68\nlangchain-openai>=0.1' },
      { path: 'agent.py',         text: LG_SIMPLE },
    ]});
    expect(g.framework_version).toBe('0.2.68');
  });
});

// ── CrewAI ───────────────────────────────────────────────────────────

const CREWAI_SIMPLE = `
from crewai import Agent, Task, Crew, Process

researcher = Agent(
    role='researcher',
    goal='Gather high-quality sources.',
    tools=[web_search, pdf_reader],
    llm=gpt4,
)
writer = Agent(
    role='writer',
    goal='Turn research into a briefing.',
    tools=[grammarly],
    llm=gpt4,
)

research_task = Task(description='Find sources', agent=researcher, tools=[web_search])
write_task    = Task(description='Draft briefing', agent=writer)

crew = Crew(
    agents=[researcher, writer],
    tasks=[research_task, write_task],
    process=Process.sequential,
)
`;

describe('WorkflowExtractorService — CrewAI', () => {
  test('extracts agents by role, sequential edge from researcher to writer', () => {
    const g = svc.extract({ files: [{ path: 'crew.py', text: CREWAI_SIMPLE }] });
    expect(g.framework).toBe('crewai');
    expect(g.nodes.map(n => n.id).sort()).toEqual(['researcher', 'writer']);
    expect(g.entry_points).toEqual(['researcher']);
    expect(g.finish_points).toEqual(['writer']);
    expect(g.edges).toEqual([expect.objectContaining({
      from: 'researcher', to: 'writer', kind: 'sequential',
    })]);
  });

  test('agent-level and task-level tool bindings merge on the same node', () => {
    const g = svc.extract({ files: [{ path: 'crew.py', text: CREWAI_SIMPLE }] });
    const researcherTools = g.tool_bindings
      .filter(b => b.node_id === 'researcher')
      .map(b => b.tool_name);
    // web_search appears at agent level AND task level.
    expect(researcherTools).toEqual(expect.arrayContaining(['web_search', 'pdf_reader']));
  });
});

// ── AutoGen ───────────────────────────────────────────────────────────

const AUTOGEN_ROUNDROBIN = `
from autogen_agentchat.agents import AssistantAgent, UserProxyAgent
from autogen_agentchat.teams import RoundRobinGroupChat

planner = AssistantAgent(
    name='planner',
    llm_config={"model": "gpt-4o-mini"},
    system_message='You plan the trip.',
    tools=[book_flight, book_hotel],
)
reviewer = AssistantAgent(
    name='reviewer',
    llm_config={"model": "gpt-4o"},
    system_message='You approve or reject.',
)
user = UserProxyAgent(name='user', human_input_mode='ALWAYS')

team = RoundRobinGroupChat(participants=[planner, reviewer, user])
`;

describe('WorkflowExtractorService — AutoGen', () => {
  test('extracts 3 agents with round-robin ring edges', () => {
    const g = svc.extract({ files: [{ path: 'team.py', text: AUTOGEN_ROUNDROBIN }] });
    expect(g.framework).toBe('autogen');
    const nodeIds = g.nodes.map(n => n.id).sort();
    expect(nodeIds).toEqual(['planner', 'reviewer', 'user']);
    // 3 sequential edges around the ring.
    expect(g.edges.length).toBe(3);
    expect(g.edges.every(e => e.kind === 'sequential')).toBe(true);
    // User is a human node (human_input_mode != NEVER).
    const userNode = g.nodes.find(n => n.id === 'user');
    expect(userNode?.kind).toBe('human');
    // Entry point = first participant.
    expect(g.entry_points).toEqual(['planner']);
  });

  test('LLM model surfaces via llm_config { model: "…" }', () => {
    const g = svc.extract({ files: [{ path: 'team.py', text: AUTOGEN_ROUNDROBIN }] });
    const planner = g.nodes.find(n => n.id === 'planner');
    expect(planner?.metadata.llm_model).toBe('gpt-4o-mini');
  });
});

// ── Mastra ────────────────────────────────────────────────────────────

const MASTRA_TRIP = `
import { Agent } from '@mastra/core/agent';
import { createWorkflow } from '@mastra/core';
import { openai } from '@ai-sdk/openai';

const research = new Agent({
  name: 'research',
  instructions: 'You gather sources.',
  model: openai('gpt-4o-mini'),
  tools: { webSearch, pdfExtract },
});
const planner = new Agent({
  name: 'planner',
  instructions: 'You plan itineraries.',
  model: openai('gpt-4o'),
  tools: { flightSearch, hotelSearch },
});
const critic = new Agent({
  name: 'critic',
  instructions: 'You approve the plan.',
  model: openai('gpt-4o-mini'),
});

const wf = createWorkflow({ id: 'trip-planner' })
  .step(research)
  .then(planner)
  .then(critic)
  .commit();
`;

describe('WorkflowExtractorService — Mastra', () => {
  test('extracts 3 agents in a linear chain', () => {
    const g = svc.extract({ files: [{ path: 'wf.ts', text: MASTRA_TRIP }] });
    expect(g.framework).toBe('mastra');
    expect(g.source.language).toBe('typescript');
    expect(g.nodes.map(n => n.id).sort()).toEqual(['critic', 'planner', 'research']);
    expect(g.entry_points).toEqual(['research']);
    expect(g.finish_points).toEqual(['critic']);
    // Two sequential edges: research → planner, planner → critic.
    expect(g.edges.filter(e => e.kind === 'sequential').length).toBe(2);
  });

  test('picks up openai("model") from the model field', () => {
    const g = svc.extract({ files: [{ path: 'wf.ts', text: MASTRA_TRIP }] });
    const research = g.nodes.find(n => n.id === 'research');
    expect(research?.metadata.llm_model).toBe('gpt-4o-mini');
  });
});

// ── Cross-cutting ─────────────────────────────────────────────────────

describe('WorkflowExtractorService — orchestration', () => {
  test('multi-framework repo picks highest confidence + warns', () => {
    const g = svc.extract({ files: [
      { path: 'crew.py',  text: CREWAI_SIMPLE },
      { path: 'wf.ts',    text: MASTRA_TRIP },
    ]});
    expect(['crewai', 'mastra']).toContain(g.framework);
    expect(g.warnings.some(w => w.code === 'MULTI_FRAMEWORK_DETECTED')).toBe(true);
  });

  test('empty input returns an unknown-framework empty graph', () => {
    const g = svc.extract({ files: [] });
    expect(g.framework).toBe('unknown');
    expect(g.nodes.length).toBe(0);
    expect(g.warnings.length).toBeGreaterThan(0);
  });

  test('cycle detection warns when a node reaches back to an ancestor', () => {
    const g = svc.extract({ files: [{ path: 'x.py', text: `
from langgraph.graph import StateGraph
builder = StateGraph(dict)
builder.add_node("a", fn_a)
builder.add_node("b", fn_b)
builder.set_entry_point("a")
builder.add_edge("a", "b")
builder.add_edge("b", "a")
    ` }]});
    expect(g.warnings.some(w => w.code === 'CYCLE_DETECTED')).toBe(true);
  });

  test('unreachable node warns', () => {
    const g = svc.extract({ files: [{ path: 'x.py', text: `
from langgraph.graph import StateGraph
builder = StateGraph(dict)
builder.add_node("main", fn_main)
builder.add_node("orphan", fn_orphan)
builder.set_entry_point("main")
    ` }]});
    expect(g.warnings.some(w => w.code === 'UNREACHABLE_NODE')).toBe(true);
  });
});

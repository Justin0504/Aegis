# AgentGuard Compliance Cockpit

Real-time monitoring and auditing dashboard for AI agents built with Next.js 14, TypeScript, and Tailwind CSS.

## Features

### Dashboard Overview
- **Real-time Statistics**: Active agents, total traces, pending approvals, violations
- **Activity Monitoring**: Live agent activity charts
- **Recent Traces**: Quick view of latest agent actions
- **Violation Tracking**: Policy violations by type and severity
- **Approval Analytics**: Approval rates and response times

### Trace Explorer
- **Comprehensive List**: Searchable and filterable trace history
- **Detailed View**: Complete trace information including:
  - Input context and prompts
  - Thought chain (reasoning process)
  - Tool calls and arguments
  - Safety validation results
  - Cryptographic signatures and hash chain
- **Export Functionality**: Download forensic evidence bundles

### Decision Graph Visualization
- **Visual Flow**: ReactFlow-based visualization of agent reasoning
- **Risk Indicators**: Color-coded nodes for policy violations
- **Interactive Navigation**: Zoom, pan, and minimap controls
- **Relationship Tracking**: Parent-child trace relationships

### Time-Travel Debugger
- **Step-by-Step Replay**: Navigate through agent execution history
- **State Reconstruction**: View agent state at any point in time
- **Playback Controls**: Play, pause, skip functionality
- **Timeline Slider**: Quickly jump to specific points

### Policy Management
- **Policy List**: View and manage safety policies
- **Risk Levels**: LOW, MEDIUM, HIGH, CRITICAL classifications
- **Enable/Disable**: Toggle policies on/off
- **Testing Interface**: Test policies against sample tool calls

### Approval Workflows
- **Pending Queue**: List of high-risk operations awaiting approval
- **Quick Actions**: Approve/Reject with reasons
- **Approval History**: Track decision audit trail
- **Statistics**: Average response times and approval rates

## Technology Stack

- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **UI Components**: Shadcn/UI with Radix UI primitives
- **Data Fetching**: TanStack Query (React Query)
- **Charts**: Recharts
- **Flow Diagrams**: React Flow
- **State Management**: React hooks and context

## Getting Started

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

## Environment Variables

```env
NEXT_PUBLIC_GATEWAY_URL=http://localhost:8080
```

## API Integration

The dashboard connects to the AgentGuard Gateway API:

- `/api/gateway/traces` - Trace management
- `/api/gateway/policies` - Policy configuration
- `/api/gateway/approvals` - Approval workflows
- `/api/gateway/stats` - Dashboard statistics

## UI Components

All UI components are built using Shadcn/UI patterns:
- Consistent design system
- Dark mode support
- Responsive layouts
- Accessible by default

## Performance

- Server-side rendering for initial load
- Client-side data fetching with caching
- Optimistic updates for user actions
- Real-time updates via polling (WebSocket support planned)
'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { AlertRules } from './alert-rules'

export function SettingsView() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Gateway configuration, alerts, and SDK connection details</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Gateway</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <div><span className="font-medium">API URL:</span> http://localhost:8080</div>
          <div><span className="font-medium">WebSocket:</span> ws://localhost:8080/mcp</div>
          <div><span className="font-medium">Health:</span>{' '}
            <span className="text-green-600 font-medium">Online</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Alert Rules</CardTitle>
        </CardHeader>
        <CardContent>
          <AlertRules />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">SDK Quick Start</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="text-xs bg-muted rounded p-4 overflow-auto">{`pip install agentguard-aegis

import agentguard
agentguard.auto("http://localhost:8080", agent_id="my-agent")

# Everything below is unchanged — no decorators needed
client = anthropic.Anthropic()
response = client.messages.create(...)`}</pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Kill Switch</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          An agent is automatically revoked after 3 policy violations within 1 hour.
          Manual revocation via API: <code className="bg-muted px-1 rounded">POST /api/v1/agents/:id/revoke</code>
        </CardContent>
      </Card>
    </div>
  )
}

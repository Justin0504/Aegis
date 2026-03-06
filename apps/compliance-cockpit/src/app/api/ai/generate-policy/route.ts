import { NextRequest, NextResponse } from 'next/server'

const SYSTEM_PROMPT = `You are a security policy generator for AEGIS, an AI agent auditing platform.
Given a plain-English description, generate a JSON security policy.

Return ONLY valid JSON with this exact shape:
{
  "id": "kebab-case-id",
  "name": "Short Human Name",
  "description": "One sentence describing what this policy does.",
  "risk_level": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "policy_schema": { /* JSON Schema object validating tool arguments */ }
}

The policy_schema must be a valid JSON Schema (draft-07) that will be used to validate tool call arguments.
Use "not" + "pattern" for blocking specific strings.
Use "maxLength" to limit data size.
Use "pattern" with "^https://" to enforce HTTPS.
Choose risk_level based on severity: CRITICAL for code execution/exfil, HIGH for destructive ops, MEDIUM for sensitive access, LOW for audit only.`

export async function POST(request: NextRequest) {
  try {
    const { description, provider, apiKey } = await request.json()

    if (!description?.trim()) {
      return NextResponse.json({ error: 'description is required' }, { status: 400 })
    }
    if (!apiKey?.trim()) {
      return NextResponse.json({ error: 'apiKey is required — configure it in Settings → AI Assistant' }, { status: 400 })
    }

    let policyJson: string

    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: description }],
        }),
      })
      if (!res.ok) {
        const err = await res.text()
        return NextResponse.json({ error: `Anthropic API error: ${err}` }, { status: 502 })
      }
      const data = await res.json()
      policyJson = data.content?.[0]?.text ?? ''
    } else {
      // OpenAI (default)
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user',   content: description },
          ],
        }),
      })
      if (!res.ok) {
        const err = await res.text()
        return NextResponse.json({ error: `OpenAI API error: ${err}` }, { status: 502 })
      }
      const data = await res.json()
      policyJson = data.choices?.[0]?.message?.content ?? ''
    }

    // Extract JSON from response (handle markdown code fences)
    const match = policyJson.match(/```(?:json)?\s*([\s\S]*?)```/) ?? policyJson.match(/(\{[\s\S]*?\})\s*$/)
    const jsonStr = match ? match[1].trim() : policyJson.trim()
    const policy = JSON.parse(jsonStr)

    return NextResponse.json({ policy })
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? 'Failed to generate policy' }, { status: 500 })
  }
}

import { detectAnomalies } from './anomaly'

interface ReportData {
  traces: any[]
  generatedAt: Date
}

export async function exportComplianceReport(data: ReportData): Promise<void> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

  const { traces, generatedAt } = data
  const W = 210
  const MARGIN = 20
  const CONTENT_W = W - MARGIN * 2
  let y = 0

  // ── Colors ──
  const GOLD    = [180, 140, 60]  as [number, number, number]
  const DARK    = [28,  24,  20]  as [number, number, number]
  const MUTED   = [120, 108, 96]  as [number, number, number]
  const SUCCESS = [40,  130, 80]  as [number, number, number]
  const DANGER  = [200, 60,  60]  as [number, number, number]
  const WARN    = [200, 140, 40]  as [number, number, number]
  const BORDER  = [220, 210, 195] as [number, number, number]
  const BG_WARM = [248, 245, 240] as [number, number, number]

  function setColor(r: number, g: number, b: number) { doc.setTextColor(r, g, b) }
  function setFill(r: number, g: number, b: number)  { doc.setFillColor(r, g, b) }
  function setDraw(r: number, g: number, b: number)  { doc.setDrawColor(r, g, b) }

  function newPage() {
    doc.addPage()
    y = MARGIN
    // Page border line
    setDraw(...BORDER)
    doc.setLineWidth(0.3)
    doc.rect(10, 10, W - 20, 277, 'S')
    y = 18
  }

  function checkPage(needed = 12) {
    if (y + needed > 275) newPage()
  }

  // ── Cover page ─────────────────────────────────────────────────────────
  // Gold header bar
  setFill(...GOLD)
  doc.rect(0, 0, W, 45, 'F')

  // AEGIS title
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(28)
  setColor(255, 255, 255)
  doc.text('AEGIS', MARGIN, 22)

  doc.setFontSize(10)
  doc.setFont('helvetica', 'normal')
  setColor(240, 230, 200)
  doc.text('AI Agent Intelligence & Security', MARGIN, 30)
  doc.text('Compliance Audit Report', MARGIN, 37)

  y = 60

  // Report metadata box
  setFill(...BG_WARM)
  setDraw(...BORDER)
  doc.setLineWidth(0.3)
  doc.roundedRect(MARGIN, y, CONTENT_W, 35, 2, 2, 'FD')

  doc.setFontSize(8)
  doc.setFont('helvetica', 'bold')
  setColor(...MUTED)
  doc.text('GENERATED', MARGIN + 5, y + 8)
  doc.text('TOTAL TRACES', MARGIN + 60, y + 8)
  doc.text('AGENTS', MARGIN + 115, y + 8)
  doc.text('ERROR RATE', MARGIN + 150, y + 8)

  const agentIds = Array.from(new Set(traces.map((t: any) => t.agent_id).filter(Boolean)))
  const errors   = traces.filter(t => t.observation?.error).length
  const errRate  = traces.length > 0 ? Math.round((errors / traces.length) * 100) : 0

  doc.setFontSize(13)
  doc.setFont('helvetica', 'bold')
  setColor(...DARK)
  doc.text(generatedAt.toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' }), MARGIN + 5, y + 20)
  doc.text(String(traces.length), MARGIN + 60, y + 20)
  doc.text(String(agentIds.length), MARGIN + 115, y + 20)

  const errColor = errRate > 20 ? DANGER : errRate > 5 ? WARN : SUCCESS
  setColor(...errColor)
  doc.text(`${errRate}%`, MARGIN + 150, y + 20)

  doc.setFontSize(8)
  doc.setFont('helvetica', 'normal')
  setColor(...MUTED)
  doc.text(generatedAt.toLocaleTimeString(), MARGIN + 5, y + 28)

  y += 50

  // ── Executive Summary ──────────────────────────────────────────────────
  doc.setFontSize(13)
  doc.setFont('helvetica', 'bold')
  setColor(...DARK)
  doc.text('Executive Summary', MARGIN, y)
  setDraw(...GOLD)
  doc.setLineWidth(0.8)
  doc.line(MARGIN, y + 2, MARGIN + 50, y + 2)
  y += 10

  const withDur    = traces.filter(t => t.observation?.duration_ms !== undefined)
  const avgLatency = withDur.length
    ? Math.round(withDur.reduce((s, t) => s + t.observation.duration_ms, 0) / withDur.length)
    : 0

  const toolFreq: Record<string, number> = {}
  for (const t of traces) {
    const tool = t.tool_call?.tool_name || 'unknown'
    toolFreq[tool] = (toolFreq[tool] || 0) + 1
  }
  const topTool = Object.entries(toolFreq).sort((a, b) => b[1] - a[1])[0]

  const summaryItems = [
    [`Total Traces Audited`, String(traces.length)],
    [`Active Agents`, String(agentIds.length)],
    [`Successful Operations`, `${traces.length - errors} (${100 - errRate}%)`],
    [`Failed Operations`, `${errors} (${errRate}%)`],
    [`Average Tool Latency`, avgLatency > 0 ? `${avgLatency}ms` : 'N/A'],
    [`Most Used Tool`, topTool ? `${topTool[0]} (${topTool[1]}×)` : 'N/A'],
  ]

  for (const [label, value] of summaryItems) {
    checkPage(8)
    setFill(252, 250, 247)
    setDraw(...BORDER)
    doc.setLineWidth(0.2)
    doc.rect(MARGIN, y, CONTENT_W, 7, 'FD')
    doc.setFontSize(8)
    doc.setFont('helvetica', 'normal')
    setColor(...MUTED)
    doc.text(String(label), MARGIN + 3, y + 4.5)
    doc.setFont('helvetica', 'bold')
    setColor(...DARK)
    doc.text(String(value), MARGIN + CONTENT_W - 3, y + 4.5, { align: 'right' })
    y += 7.5
  }

  // ── Anomaly Detection ──────────────────────────────────────────────────
  y += 6
  checkPage(20)
  doc.setFontSize(13)
  doc.setFont('helvetica', 'bold')
  setColor(...DARK)
  doc.text('Anomaly Detection', MARGIN, y)
  setDraw(...GOLD)
  doc.setLineWidth(0.8)
  doc.line(MARGIN, y + 2, MARGIN + 55, y + 2)
  y += 10

  const anomalies = detectAnomalies(traces)
  if (anomalies.length === 0) {
    doc.setFontSize(9)
    doc.setFont('helvetica', 'italic')
    setColor(...SUCCESS)
    doc.text('✓  No anomalies detected — system operating within normal parameters', MARGIN, y)
    y += 8
  } else {
    for (const a of anomalies) {
      checkPage(14)
      const bgColor: [number, number, number] = a.severity === 'high' ? [255, 242, 242] : a.severity === 'medium' ? [255, 248, 235] : [235, 245, 255]
      const dotColor = a.severity === 'high' ? DANGER : a.severity === 'medium' ? WARN : [60, 130, 200] as [number, number, number]
      setFill(...bgColor)
      setDraw(...dotColor)
      doc.setLineWidth(0.5)
      doc.roundedRect(MARGIN, y, CONTENT_W, 12, 1.5, 1.5, 'FD')
      // severity badge
      setFill(...dotColor)
      doc.roundedRect(MARGIN + 3, y + 3, 18, 6, 1, 1, 'F')
      doc.setFontSize(6)
      doc.setFont('helvetica', 'bold')
      setColor(255, 255, 255)
      doc.text(a.severity.toUpperCase(), MARGIN + 12, y + 7, { align: 'center' })
      // title + detail
      doc.setFontSize(8)
      doc.setFont('helvetica', 'bold')
      setColor(...DARK)
      doc.text(a.title, MARGIN + 24, y + 5.5)
      doc.setFont('helvetica', 'normal')
      setColor(...MUTED)
      doc.text(a.detail, MARGIN + 24, y + 9.5)
      y += 14
    }
  }

  // ── Trace Log ─────────────────────────────────────────────────────────
  y += 4
  checkPage(25)
  doc.setFontSize(13)
  doc.setFont('helvetica', 'bold')
  setColor(...DARK)
  doc.text('Trace Audit Log', MARGIN, y)
  setDraw(...GOLD)
  doc.setLineWidth(0.8)
  doc.line(MARGIN, y + 2, MARGIN + 48, y + 2)
  y += 10

  // Table header
  const COL = [0, 32, 60, 100, 130, 155] // relative to MARGIN
  const ROW_H = 7
  setFill(...GOLD)
  doc.rect(MARGIN, y, CONTENT_W, ROW_H, 'F')
  doc.setFontSize(7)
  doc.setFont('helvetica', 'bold')
  setColor(255, 255, 255)
  const headers = ['Timestamp', 'Agent', 'Tool', 'Prompt', 'Duration', 'Status']
  headers.forEach((h, i) => doc.text(h, MARGIN + COL[i] + 2, y + 4.5))
  y += ROW_H

  // Table rows (max 100)
  const sample = traces.slice(0, 100)
  for (let i = 0; i < sample.length; i++) {
    const t = sample[i]
    checkPage(ROW_H + 2)

    // Alternating row bg
    if (i % 2 === 0) {
      setFill(252, 250, 247)
    } else {
      setFill(255, 255, 255)
    }
    setDraw(...BORDER)
    doc.setLineWidth(0.1)
    doc.rect(MARGIN, y, CONTENT_W, ROW_H, 'FD')

    doc.setFontSize(6.5)
    doc.setFont('helvetica', 'normal')
    setColor(...DARK)

    const ts     = new Date(t.timestamp).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })
    const agent  = (t.agent_id || '').substring(0, 8)
    const tool   = (t.tool_call?.tool_name || '—').substring(0, 16)
    const prompt = (t.input_context?.prompt || '—').substring(0, 28)
    const dur    = t.observation?.duration_ms !== undefined ? `${Math.round(t.observation.duration_ms)}ms` : '—'
    const hasErr = !!t.observation?.error

    const cells = [ts, agent, tool, prompt, dur]
    cells.forEach((cell, ci) => doc.text(cell, MARGIN + COL[ci] + 2, y + 4.5))

    // Status badge
    const statusColor = hasErr ? DANGER : SUCCESS
    setColor(...statusColor)
    doc.setFont('helvetica', 'bold')
    doc.text(hasErr ? 'ERROR' : 'OK', MARGIN + COL[5] + 2, y + 4.5)

    y += ROW_H
  }

  if (traces.length > 100) {
    checkPage(8)
    doc.setFontSize(7)
    doc.setFont('helvetica', 'italic')
    setColor(...MUTED)
    doc.text(`… and ${traces.length - 100} more traces (showing first 100)`, MARGIN, y + 5)
    y += 8
  }

  // ── Footer on every page ───────────────────────────────────────────────
  const totalPages = (doc as any).internal.getNumberOfPages()
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p)
    setFill(...BG_WARM)
    doc.rect(0, 285, W, 12, 'F')
    setDraw(...BORDER)
    doc.setLineWidth(0.3)
    doc.line(MARGIN, 285, W - MARGIN, 285)
    doc.setFontSize(7)
    doc.setFont('helvetica', 'normal')
    setColor(...MUTED)
    doc.text('AEGIS — AI Agent Intelligence & Security', MARGIN, 291)
    doc.text(`Page ${p} of ${totalPages}`, W - MARGIN, 291, { align: 'right' })
    doc.text(`Generated ${generatedAt.toISOString()}`, W / 2, 291, { align: 'center' })
  }

  // ── Save ───────────────────────────────────────────────────────────────
  const filename = `aegis-report-${generatedAt.toISOString().split('T')[0]}.pdf`
  doc.save(filename)
}

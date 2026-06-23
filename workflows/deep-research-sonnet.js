export const meta = {
  name: 'deep-research-sonnet',
  description: 'Sonnet-pinned deep-research harness: decompose a question into axes, fan out one Sonnet researcher per axis (web-search grounded), adversarially verify each report\'s load-bearing claims, synthesize a cited report with a decision table. The canonical deep-research path (the built-in deep-research skill inherits the session model -> Opus burn; this file pins model:"sonnet" at every agent site). args: { question: string (required), axes?: string[], maxAxes?: number }.',
  phases: [
    { title: 'PLAN', detail: 'one sonnet agent decomposes the question into research axes (skipped if args.axes provided)' },
    { title: 'RESEARCH', detail: 'one sonnet researcher per axis, web-search grounded, truth-calibrated' },
    { title: 'VERIFY', detail: 'one sonnet skeptic per report adversarially refutes its load-bearing claims' },
    { title: 'SYNTHESIZE', detail: 'one sonnet agent merges verified reports into a cited report + decision table' },
  ],
}

// args may arrive as a parsed object or a JSON string; normalize.
let a = args || {}
if (typeof a === 'string') { try { a = JSON.parse(a) } catch (e) { a = {} } }
const question = (a && a.question ? String(a.question) : '').trim()
if (!question) return { error: 'deep-research-sonnet: args.question is required' }
const maxAxes = Number.isFinite(a.maxAxes) ? Math.max(2, Math.min(8, a.maxAxes)) : 5

const REPORT = {
  type: 'object', additionalProperties: true,
  required: ['findings', 'failureModes', 'recommendation'],
  properties: {
    findings: { type: 'array', items: { type: 'object', additionalProperties: true } },
    failureModes: { type: 'array', items: { type: 'string' } },
    recommendation: { type: 'string' },
  },
}
const VERIFY = {
  type: 'object', additionalProperties: true, required: ['checks'],
  properties: { checks: { type: 'array', items: { type: 'object', additionalProperties: true } } },
}
const PLAN = {
  type: 'object', additionalProperties: true, required: ['axes'],
  properties: { axes: { type: 'array', items: { type: 'string' } } },
}

// PLAN -- decompose into axes unless the caller supplied them.
let axes = Array.isArray(a.axes) && a.axes.length > 0 ? a.axes.slice(0, maxAxes) : null
if (!axes) {
  const plan = await agent(
    `Decompose this research question into ${maxAxes} distinct, non-overlapping research axes (each a concrete sub-question worth a dedicated web search). Question:\n\n${question}\n\nReturn { axes: [string, ...] }.`,
    { label: 'plan', phase: 'PLAN', model: 'sonnet', schema: PLAN }
  )
  axes = (plan && Array.isArray(plan.axes) && plan.axes.length > 0) ? plan.axes.slice(0, maxAxes) : [question]
}

// RESEARCH -> VERIFY, pipelined per axis (each verifies as soon as its research lands).
const reports = await pipeline(
  axes,
  (axis) => agent(
    `Use web search (find the WebSearch/WebFetch tools via ToolSearch first). Research, truth-calibrated, this axis of the overall question "${question}":\n\n${axis}\n\nReport what the evidence ACTUALLY says (a well-supported "it depends / no strong evidence" is a valid answer). Return findings (each {claim, evidence, source, date, confidence}), failureModes the approach introduces, and a one-paragraph recommendation. Cite sources with dates; prefer primary sources (docs, papers, post-mortems) over vendor marketing.`,
    { label: 'research', phase: 'RESEARCH', model: 'sonnet', schema: REPORT }
  ),
  (rep, axis, i) => agent(
    `Adversarially verify the 2-3 most load-bearing claims in this research report on axis "${axis}". Try to REFUTE each with counter-sources; default to skeptical. Report: ${JSON.stringify(rep).slice(0, 6000)}\n\nReturn checks: [{claim, verdict: "holds"|"refuted"|"mixed", counterEvidence, note}].`,
    { label: 'verify', phase: 'VERIFY', model: 'sonnet', schema: VERIFY }
  ).then((v) => ({ axis, report: rep, verify: v }))
)

// SYNTHESIZE -- one sonnet agent merges the verified reports.
const synthesis = await agent(
  `Synthesize these ${reports.filter(Boolean).length} verified research reports into a cited answer to the question:\n\n"${question}"\n\nGive a clear recommendation, flag where the evidence was weak or a verifier refuted a claim, and END with a decision table: | Option | Evidence summary | Key risk | Recommendation |.\n\nReports: ${JSON.stringify(reports.filter(Boolean)).slice(0, 24000)}`,
  { label: 'synthesize', phase: 'SYNTHESIZE', model: 'sonnet' }
)

return { question, axes, perAxis: reports.filter(Boolean), synthesis }

#!/usr/bin/env node
// agenttype_precheck.mjs -- pre-launch disk precheck (pipeline-meritocracy chunk 6).
//
// Given a chunk tier (default | heavy; legacy S/A/B/C still resolve via the dial),
// enumerate the agentTypes that tier's worker-pipeline will dispatch and verify each
// agents/<name>.md exists ON DISK. Exit 0 when every file is present; exit non-zero,
// naming each missing file, when any is absent.
//
// WHY (the agents-do-not-hot-reload memory): the cockpit runs this in its pre-launch
// isolation-guard step to catch a NOT-YET-CREATED / NOT-YET-MERGED agent file BEFORE a
// pipeline launches and crashes mid-run with `agent type 'X' not found`. A disk
// precheck does NOT catch REGISTRATION LAG (the file is on disk but the running session
// has not registered it) -- that is the pipeline's graceful agenttype-unavailable bundle
// (workflows/agenttype-precheck.mjs's classifier, inlined into worker-pipeline.js).
//
// Usage:
//   node scripts/agenttype_precheck.mjs <tier> [--agents-dir <dir>] [--verbose]
//     <tier>          default | heavy   (legacy S/A/B/C resolve via the dial)
//     --agents-dir    override the agents/ dir (default: <repo-root>/agents); used by
//                     the test to point at an empty dir so every file reads missing
//     --verbose       echo each checked path + result to stderr (default-quiet diagnostics)
//
// Exit codes: 0 = all present; 1 = >=1 missing (names listed on stderr); 2 = usage error.

import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expectedAgentTypesForTier } from '../workflows/agenttype-precheck.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

function parseArgs(argv) {
  const args = { tier: null, agentsDir: null, verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--agents-dir') { args.agentsDir = argv[++i]; continue }
    if (v === '--verbose') { args.verbose = true; continue }
    if (v.startsWith('--')) { continue }
    if (args.tier === null) { args.tier = v; continue }
  }
  return args
}

const { tier, agentsDir, verbose } = parseArgs(process.argv.slice(2))
const vlog = (...m) => { if (verbose) console.error('[agenttype_precheck]', ...m) }

if (!tier) {
  console.error('agenttype_precheck: a tier argument is required (default | heavy).')
  console.error('usage: node scripts/agenttype_precheck.mjs <tier> [--agents-dir <dir>] [--verbose]')
  process.exit(2)
}

const dir = agentsDir || join(repoRoot, 'agents')
const expected = expectedAgentTypesForTier(tier)
vlog(`tier=${tier} -> agentTypes [${expected.join(', ')}]; agents dir=${dir}`)

const missing = []
for (const name of expected) {
  const path = join(dir, `${name}.md`)
  const ok = existsSync(path)
  vlog(`  ${ok ? 'OK     ' : 'MISSING'} ${name}.md -> ${path}`)
  if (!ok) missing.push(name)
}

if (missing.length) {
  console.error(
    `agenttype_precheck: ${missing.length} agent file(s) MISSING for tier '${tier}': ` +
    missing.map((n) => `${n}.md`).join(', ') +
    `. Create/merge the agent file(s) before launching a pipeline that dispatches them.`,
  )
  process.exit(1)
}

console.log(`agenttype_precheck: OK -- all ${expected.length} agent files present for tier '${tier}' (${expected.map((n) => `${n}.md`).join(', ')}).`)
process.exit(0)

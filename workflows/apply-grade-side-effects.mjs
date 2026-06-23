#!/usr/bin/env node
// apply-grade-side-effects.mjs -- sole-writer entrypoint for the three auto-apply
// grader side effects: corpus append, reader-model updates, ledger append.
//
// Usage:
//   node workflows/apply-grade-side-effects.mjs \
//     --grade   <path/to/grade-result.json> \
//     --corpus  <path/to/voice-corpus.md> \
//     --reader-model <path/to/reader-model.md> \
//     --ledger  <path/to/ledger.md> \
//     [--verbose]
//
// Reads the grade-result JSON and applies three keys via the lib helpers:
//   corpusAppend      -> applyCorpusAppend  -> corpus file
//   readerModelUpdates -> applyReaderModelUpdates -> reader-model file
//   ledgerLines       -> applyLedgerLines   -> ledger file
//
// All three apply-fns are pure (idempotent, dedup-guarded); re-running against the
// same grade JSON produces identical file content (idempotent end-to-end).
//
// Diagnostics:
//   --verbose: emits one line to stderr per file applied.
//   Errors (unreadable file, bad JSON): always emitted to stderr; exits non-zero.

import { readFileSync, writeFileSync } from 'node:fs'

// Import the lib helpers (same dir, ES module).
import { applyCorpusAppend, applyReaderModelUpdates, applyLedgerLines } from './grader-workflow-lib.mjs'

// ---------------------------------------------------------------------------
// Arg parsing (minimal, no deps)
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--verbose') { args.verbose = true; continue }
    if (a === '--grade' && argv[i + 1]) { args.grade = argv[++i]; continue }
    if (a === '--corpus' && argv[i + 1]) { args.corpus = argv[++i]; continue }
    if ((a === '--reader-model') && argv[i + 1]) { args.readerModel = argv[++i]; continue }
    if (a === '--ledger' && argv[i + 1]) { args.ledger = argv[++i]; continue }
  }
  return args
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2))
  const verbose = !!args.verbose

  if (!args.grade || !args.corpus || !args.readerModel || !args.ledger) {
    process.stderr.write('apply-grade-side-effects: missing required args --grade --corpus --reader-model --ledger\n')
    process.exit(1)
  }

  // Read the grade-result JSON.
  let grade
  try {
    grade = JSON.parse(readFileSync(args.grade, 'utf8'))
  } catch (err) {
    process.stderr.write(`apply-grade-side-effects: failed to read grade file '${args.grade}': ${err.message}\n`)
    process.exit(1)
  }

  // Workflow envelope unwrap: if the three side-effect keys are absent at the top
  // level but present under .result (the shape the Workflow tool wraps returns in),
  // unwrap .result so downstream code sees the raw grade shape. Only unwrap when the
  // top-level keys are ALL absent -- if any top-level key is present the caller
  // already has the raw form (no double-unwrap).
  const TOP_KEYS = ['corpusAppend', 'readerModelUpdates', 'ledgerLines']
  const topKeysAbsent = TOP_KEYS.every((k) => grade[k] === undefined)
  if (topKeysAbsent && grade.result && typeof grade.result === 'object') {
    grade = grade.result
  }

  // All-empty guard: a real grade is never all-empty. If every transform would be a
  // no-op (all three keys absent or empty arrays), the caller fed us a null/corrupt
  // grade. Fail loud rather than silently doing nothing.
  const isEmpty = (v) => !v || (Array.isArray(v) && v.length === 0)
  if (isEmpty(grade.corpusAppend) && isEmpty(grade.readerModelUpdates) && isEmpty(grade.ledgerLines)) {
    process.stderr.write('apply-grade-side-effects: grade has no side-effect data (corpusAppend, readerModelUpdates, and ledgerLines are all absent or empty); refusing to silently no-op\n')
    process.exit(1)
  }

  // Build the list of (label, path, transform) triples.
  const targets = [
    { label: 'corpus',       path: args.corpus,      fn: (c) => applyCorpusAppend(c, grade.corpusAppend || []) },
    { label: 'reader-model', path: args.readerModel, fn: (c) => applyReaderModelUpdates(c, grade.readerModelUpdates || []) },
    { label: 'ledger',       path: args.ledger,       fn: (c) => applyLedgerLines(c, grade.ledgerLines || []) },
  ]

  // Phase 1: read all files and compute new content. Bail on any failure BEFORE writing.
  const writes = []
  for (const { label, path, fn } of targets) {
    let content
    try {
      content = readFileSync(path, 'utf8')
    } catch (err) {
      process.stderr.write(`apply-grade-side-effects: error reading ${label} file '${path}': ${err.message}\n`)
      process.exit(1)
    }
    let next
    try {
      next = fn(content)
    } catch (err) {
      process.stderr.write(`apply-grade-side-effects: error applying ${label}: ${err.message}\n`)
      process.exit(1)
    }
    writes.push({ label, path, content, next })
  }

  // Phase 2: write all (all reads + transforms succeeded).
  for (const { label, path, content, next } of writes) {
    if (next === content) {
      // No change; skip write; diagnostic only if verbose.
      if (verbose) {
        process.stderr.write(`apply-grade-side-effects: no-op ${label} -> ${path}\n`)
      }
      continue
    }
    try {
      writeFileSync(path, next, 'utf8')
    } catch (err) {
      process.stderr.write(`apply-grade-side-effects: error writing ${label} file '${path}': ${err.message}\n`)
      process.exit(1)
    }
    if (verbose) {
      process.stderr.write(`apply-grade-side-effects: applied ${label} -> ${path}\n`)
    }
  }
}

main()

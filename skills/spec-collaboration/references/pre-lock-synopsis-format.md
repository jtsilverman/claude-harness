# Pre-lock Teaching Synopsis: Detailed Format

Three sections, in this order:

1. **Current state** (prose, a few sentences). What exists today, in plain language. If greenfield, say so: "Today there is no X; the system does Y instead." Use the verbs and nouns the system actually involves, not spec-section names.

2. **Changes to be made** (bullets, one per chunk in implementation order). Each chunk is a top-level bullet with sub-bullets. The causal chain lives here, attached to the chunk it concerns:

   - **Chunk N: \<title\>** — one-sentence behavior shift.
     - *File or interface touched:* which path, module, or API.
     - *Behavior shift:* what changes, in plain English.
     - *Why this chunk:* the causal piece. What earlier chunks made this possible, or what this chunk enables for later ones. Example: "Chunk 1 wires X into the registry so chunk 2's helper has somewhere to plug in." Titles are labels, not explanations.

3. **End state** (prose, a few sentences). What the system looks like after the last chunk has shipped. Just the end state, not the path that got there. The causal chain belongs in section 2, paired with each chunk.

Length scales with chunk count; the per-chunk bullets are the body. Keep sections 1 and 3 tight (a few sentences each).

End with: "Does this match what you expected to be implementing? If yes, say lock. If anything reads wrong, tell me which section needs another pass." On mismatch, re-interrogate the relevant section, then produce a fresh synopsis before re-asking.

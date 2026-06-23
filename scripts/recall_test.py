#!/usr/bin/env python3
"""Characterization test for scripts/recall.sh.

This is a CHARACTERIZATION test: it locks the CURRENT behavior of the recall
bash primitives so that the extraction from skills/recall/SKILL.md is proven
behavior-preserving. It must PASS against the extracted script.

No external deps; stdlib only. Each test sources scripts/recall.sh in a bash
subprocess, calls one function against a temp fixture, and asserts on stdout
or on the side effects the function left on disk.

Pass 1 (memory) is no longer a bash primitive — it is a hybrid index query
(`node scripts/memory-index.mjs query ...`) covered by
scripts/memory-index-query.test.mjs. The retired Pass-1 helpers
(bump_tally_index / grep_failures / bump_tally_body and their recall-tally.json
sidecar) and their tests were deleted in chunk B4. This file now characterizes
only the surviving Pass-2 and Pass-3 grep primitives.

Coverage:
  (d) grep_wiki_sources — Pass 2 wiki + sources grep (Step 4)
  (e) grep_codebase    — Pass 3 git grep from repo root (Step 5.5)
"""

import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "recall.sh")

_failures = []
_passes = []


def run_bash(snippet, env=None, cwd=None):
    """Source recall.sh, then run the snippet in bash. Return (rc, stdout, stderr)."""
    full = f'source "{SCRIPT}"\n{snippet}\n'
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    proc = subprocess.run(
        ["bash", "-c", full],
        capture_output=True,
        text=True,
        env=full_env,
        cwd=cwd,
    )
    return proc.returncode, proc.stdout, proc.stderr


def check(name, cond, detail=""):
    if cond:
        _passes.append(name)
        print(f"PASS  {name}")
    else:
        _failures.append((name, detail))
        print(f"FAIL  {name}  {detail}")


# ---------------------------------------------------------------------------
# (d) grep_wiki_sources — Step 4
# ---------------------------------------------------------------------------
def test_grep_wiki_sources():
    with tempfile.TemporaryDirectory() as root:
        wiki = os.path.join(root, "wiki")
        concepts = os.path.join(wiki, "concepts")
        coding_log = os.path.join(wiki, "coding-log")
        project_dir = os.path.join(wiki, "projects", "my-project")
        sources = os.path.join(root, "sources")
        articles = os.path.join(sources, "articles")
        os.makedirs(concepts)
        os.makedirs(coding_log)
        os.makedirs(project_dir)
        os.makedirs(articles)
        # Create stub dirs for the other source subdirs (grep_wiki_sources filters
        # to dirs that exist, so missing ones are fine; just stub articles for hits)

        with open(os.path.join(concepts, "idempotent-writes.md"), "w") as f:
            f.write("description: idempotent write pattern for file updates\n\nbody.\n")
        with open(os.path.join(concepts, "rate-limiting.md"), "w") as f:
            f.write("description: token bucket rate limiting\n\nbody.\n")
        with open(os.path.join(project_dir, "notes.md"), "w") as f:
            f.write("description: project notes on idempotent approach\n\nbody.\n")
        with open(os.path.join(articles, "api-idempotent-keys.md"), "w") as f:
            f.write("description: API idempotent key patterns\n\nbody.\n")

        env = {
            "WIKI_ROOT": wiki,
            "SOURCES_ROOT": sources,
        }

        # With a project name: should search project dir too
        rc, out, err = run_bash(
            'grep_wiki_sources "my-project" "idempotent"', env=env
        )
        matched = [os.path.basename(p.strip()) for p in out.splitlines() if p.strip()]
        check(
            "(d) grep_wiki_sources finds concept file with keyword",
            "idempotent-writes.md" in matched,
            f"matched={matched} err={err!r}",
        )
        check(
            "(d) grep_wiki_sources finds project dir file when project is named",
            "notes.md" in matched,
            f"matched={matched}",
        )
        check(
            "(d) grep_wiki_sources finds sources file",
            "api-idempotent-keys.md" in matched,
            f"matched={matched}",
        )
        check(
            "(d) grep_wiki_sources excludes non-matching files",
            "rate-limiting.md" not in matched,
            f"matched={matched}",
        )

        # Without a project name: should skip project dir
        rc, out, err = run_bash(
            'grep_wiki_sources "" "idempotent"', env=env
        )
        matched_no_proj = [
            os.path.basename(p.strip()) for p in out.splitlines() if p.strip()
        ]
        check(
            "(d) grep_wiki_sources finds concept without project name",
            "idempotent-writes.md" in matched_no_proj,
            f"matched_no_proj={matched_no_proj}",
        )
        # The project dir notes.md might or might not appear (grep searches whatever
        # dirs exist; the function only adds the project dir when project != "").
        # With project="", notes.md should NOT be in results.
        check(
            "(d) grep_wiki_sources skips project dir when project is empty string",
            "notes.md" not in matched_no_proj,
            f"matched_no_proj={matched_no_proj}",
        )


# ---------------------------------------------------------------------------
# (e) grep_codebase — Step 5.5
# ---------------------------------------------------------------------------
def test_grep_codebase():
    with tempfile.TemporaryDirectory() as root:
        # Init a small git repo with a scripts/ and skills/ tree
        subprocess.run(["git", "init", root], capture_output=True)
        subprocess.run(
            ["git", "config", "user.email", "test@test.com"],
            cwd=root, capture_output=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test"],
            cwd=root, capture_output=True,
        )

        scripts_dir = os.path.join(root, "scripts")
        skills_dir = os.path.join(root, "skills")
        os.makedirs(scripts_dir)
        os.makedirs(skills_dir)

        with open(os.path.join(scripts_dir, "drain_queue.sh"), "w") as f:
            f.write("#!/bin/bash\n# drain_queue function\nfunction drain_queue() {\n  echo drain\n}\n")
        with open(os.path.join(skills_dir, "ship_skill.md"), "w") as f:
            f.write("# Ship skill\ndrain_queue behavior\n")
        with open(os.path.join(scripts_dir, "unrelated.sh"), "w") as f:
            f.write("#!/bin/bash\necho hello\n")

        # Stage and commit everything
        subprocess.run(["git", "add", "."], cwd=root, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "init"],
            cwd=root, capture_output=True,
        )

        # grep_codebase for "drain" from within the repo root
        rc, out, err = run_bash('grep_codebase "drain"', cwd=root)
        check(
            "(e) grep_codebase exits 0 when matches found",
            rc == 0,
            f"rc={rc} err={err!r}",
        )
        lines = out.splitlines()
        check(
            "(e) grep_codebase finds the keyword in the script file",
            any("drain_queue.sh" in ln for ln in lines),
            f"lines={lines}",
        )
        check(
            "(e) grep_codebase excludes .md files",
            not any("ship_skill.md" in ln for ln in lines),
            f"lines={lines} (md files should be excluded)",
        )
        check(
            "(e) grep_codebase excludes non-matching files",
            not any("unrelated.sh" in ln for ln in lines),
            f"lines={lines}",
        )

        # No match: empty output
        rc, out, err = run_bash('grep_codebase "xyzzy_no_match_ever"', cwd=root)
        check(
            "(e) grep_codebase emits no output when nothing matches",
            out.strip() == "",
            f"out={out!r}",
        )


def main():
    test_grep_wiki_sources()
    test_grep_codebase()

    print()
    print(f"{len(_passes)} passed, {len(_failures)} failed")
    if _failures:
        for name, detail in _failures:
            print(f"  FAILED: {name}  {detail}")
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()

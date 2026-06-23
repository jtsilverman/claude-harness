#!/usr/bin/env python3
"""Characterization test for scripts/ship_project.sh.

This is a CHARACTERIZATION test: it locks the CURRENT behavior of the
ship-project bash primitives so that the extraction from
skills/ship-project/SKILL.md is proven behavior-preserving. It must PASS against
the extracted script.

No external deps; stdlib only. Each test sources scripts/ship_project.sh in a
bash subprocess, calls one function against a temp fixture, and asserts on stdout
or on the side effects the function left on disk.

Coverage (per the task's minimum):
  (a) find_canonical_html — the largest-*.html heuristic over an extracted tree.
  (b) persist_html — atomic copy via tmp-derived-from-target + the collision
      guard (refuse to overwrite an existing target).
  (c) collage_round_trip — the end-to-end orchestrator (fetch -> extract ->
      persist -> render) driven against a local file:// tarball, a fixture
      project dir via the VAULT=<path> override, and a stubbed
      render-design-png.sh on PATH so no real rasterizer is needed.
Plus extract_design's README-at-root-or-one-level-deep acceptance and
collage_round_trip's missing-project-dir / collision failure paths, since they
are part of the same extracted surface.
"""

import os
import subprocess
import sys
import tarfile
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "ship_project.sh")

_failures = []
_passes = []


def run_bash(snippet, env=None, cwd=None, stdin=None):
    """Source ship_project.sh, then run the snippet in bash. Return (rc, out, err).

    No `set -e`: the primitives are sourced into a normal (non-errexit) shell in
    real invocation, and several use grep/find which return nonzero on no-match.
    """
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
        input=stdin,
    )
    return proc.returncode, proc.stdout, proc.stderr


def check(name, cond, detail=""):
    if cond:
        _passes.append(name)
        print(f"PASS  {name}")
    else:
        _failures.append((name, detail))
        print(f"FAIL  {name}  {detail}")


def _write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(content)


def _make_stub_renderer(bin_dir):
    """Create a fake render-design-png.sh under a fake HOME so the script's
    `~/.claude/scripts/render-design-png.sh` resolves to our stub. The stub
    writes a sibling .png next to the HTML it is handed and exits 0."""
    stub_dir = os.path.join(bin_dir, ".claude", "scripts")
    os.makedirs(stub_dir, exist_ok=True)
    stub = os.path.join(stub_dir, "render-design-png.sh")
    _write(
        stub,
        '#!/usr/bin/env bash\n'
        'html="$1"\n'
        'png="${html%.html}.png"\n'
        'printf "PNG" > "$png"\n'
        'exit 0\n',
    )
    os.chmod(stub, 0o755)
    return stub


# ---------------------------------------------------------------------------
# (a) find_canonical_html — largest-*.html heuristic
# ---------------------------------------------------------------------------
def test_find_canonical_html():
    with tempfile.TemporaryDirectory() as work:
        # Three HTML files of differing size; one nested. Largest must win.
        _write(os.path.join(work, "small.html"), "x" * 10)
        _write(os.path.join(work, "nested", "big.html"), "y" * 5000)
        _write(os.path.join(work, "mid.html"), "z" * 100)
        # A non-HTML file that is bigger than all of them must be ignored.
        _write(os.path.join(work, "chat.md"), "m" * 99999)

        rc, out, err = run_bash(f'find_canonical_html "{work}"')
        picked = out.strip()
        check(
            "(a) find_canonical_html returns the largest *.html (ignores .md)",
            picked == os.path.join(work, "nested", "big.html"),
            f"got {picked!r} err={err!r}",
        )


# ---------------------------------------------------------------------------
# (b) persist_html — atomic copy + collision guard
# ---------------------------------------------------------------------------
def test_persist_html():
    with tempfile.TemporaryDirectory() as root:
        src = os.path.join(root, "src.html")
        _write(src, "<html>collage</html>")
        target = os.path.join(root, "out", "L0-collage.html")
        os.makedirs(os.path.dirname(target))

        # Happy path: copies src to target, leaves no .tmp.* sibling behind.
        rc, out, err = run_bash(f'persist_html "{src}" "{target}"')
        leftover_tmps = [
            f for f in os.listdir(os.path.dirname(target))
            if f.startswith("L0-collage.html.tmp.")
        ]
        check(
            "(b) persist_html copies src to target and cleans up the tmp",
            rc == 0
            and os.path.isfile(target)
            and open(target).read() == "<html>collage</html>"
            and leftover_tmps == [],
            f"rc={rc} tmps={leftover_tmps} err={err!r}",
        )

        # Collision guard: a second call must refuse and not clobber.
        _write(src, "<html>DIFFERENT</html>")
        rc, out, err = run_bash(f'persist_html "{src}" "{target}"')
        check(
            "(b) persist_html refuses to overwrite an existing target (rc!=0)",
            rc != 0
            and open(target).read() == "<html>collage</html>"
            and "refusing to overwrite" in err,
            f"rc={rc} target={open(target).read()!r} err={err!r}",
        )


# ---------------------------------------------------------------------------
# extract_design — README at root OR one level deep
# ---------------------------------------------------------------------------
def _make_tarball(path, members):
    """members: dict of arcname -> content. Build a .tar.gz at `path`."""
    staging = tempfile.mkdtemp()
    with tarfile.open(path, "w:gz") as tar:
        for arc, content in members.items():
            full = os.path.join(staging, arc)
            _write(full, content)
            tar.add(full, arcname=arc)


def test_extract_design():
    with tempfile.TemporaryDirectory() as root:
        # Wrapper-dir format: README one level deep + an html inside.
        tarball = os.path.join(root, "wrapped.tar.gz")
        _make_tarball(
            tarball,
            {
                "claude-myproj/README.md": "# readme",
                "claude-myproj/render.html": "<html>" + "h" * 2000 + "</html>",
            },
        )
        work = os.path.join(root, "extract-wrapped")
        rc, out, err = run_bash(f'extract_design "{tarball}" "{work}"')
        check(
            "(extra) extract_design accepts README one level deep (wrapper dir)",
            rc == 0,
            f"rc={rc} err={err!r}",
        )

        # Root format: README at tarball root.
        tarball2 = os.path.join(root, "rooted.tar.gz")
        _make_tarball(
            tarball2,
            {"README.md": "# readme", "render.html": "<html>root</html>"},
        )
        work2 = os.path.join(root, "extract-root")
        rc, out, err = run_bash(f'extract_design "{tarball2}" "{work2}"')
        check(
            "(extra) extract_design accepts README at tarball root (legacy)",
            rc == 0,
            f"rc={rc} err={err!r}",
        )

        # No README anywhere -> failure.
        tarball3 = os.path.join(root, "noreadme.tar.gz")
        _make_tarball(tarball3, {"render.html": "<html>x</html>"})
        work3 = os.path.join(root, "extract-noreadme")
        rc, out, err = run_bash(f'extract_design "{tarball3}" "{work3}"')
        check(
            "(extra) extract_design fails when no README.md is present",
            rc != 0,
            f"rc={rc}",
        )


# ---------------------------------------------------------------------------
# (c) collage_round_trip — end-to-end orchestrator
# ---------------------------------------------------------------------------
def test_collage_round_trip():
    with tempfile.TemporaryDirectory() as root:
        fake_home = os.path.join(root, "home")
        _make_stub_renderer(fake_home)

        vault = os.path.join(root, "vault")
        slug = "demo-project"
        proj_dir = os.path.join(vault, "wiki", "projects", slug)
        os.makedirs(proj_dir)

        # Build a Claude-Design-shaped tarball and serve it via a file:// URL
        # (curl -fsSL handles file://, so no network is touched).
        tarball = os.path.join(root, "design.tar.gz")
        big_html = "<html>" + "C" * 4000 + "</html>"
        _make_tarball(
            tarball,
            {
                "claude-demo/README.md": "# readme",
                "claude-demo/collage.html": big_html,
                "claude-demo/chats/notes.md": "n" * 9999,  # bigger but not .html
            },
        )
        url = "file://" + tarball
        env = {"HOME": fake_home, "VAULT": vault}

        rc, out, err = run_bash(
            f'collage_round_trip "{url}" "{slug}"', env=env
        )
        lines = [l for l in out.splitlines() if l.strip()]
        html_target = os.path.join(proj_dir, "L0-collage.html")
        png_target = os.path.join(proj_dir, "L0-collage.png")
        check(
            "(c) collage_round_trip succeeds end-to-end (rc 0)",
            rc == 0,
            f"rc={rc} out={out!r} err={err!r}",
        )
        check(
            "(c) collage_round_trip emits HTML then PNG target paths on stdout",
            lines == [html_target, png_target],
            f"lines={lines!r}",
        )
        check(
            "(c) collage_round_trip persisted the canonical (largest) HTML",
            os.path.isfile(html_target) and open(html_target).read() == big_html,
            f"exists={os.path.isfile(html_target)}",
        )
        check(
            "(c) collage_round_trip produced the PNG sibling via the renderer",
            os.path.isfile(png_target),
            f"exists={os.path.isfile(png_target)}",
        )

        # Re-run hits the persist_html collision guard -> fails, HTML unchanged.
        rc2, out2, err2 = run_bash(
            f'collage_round_trip "{url}" "{slug}"', env=env
        )
        check(
            "(c) collage_round_trip refuses a second run (collage already present)",
            rc2 != 0 and open(html_target).read() == big_html,
            f"rc2={rc2} err2={err2!r}",
        )

        # Missing project dir -> fail-loud before any fetch.
        rc3, out3, err3 = run_bash(
            f'collage_round_trip "{url}" "no-such-project"', env=env
        )
        check(
            "(c) collage_round_trip fails loudly when the project dir is missing",
            rc3 != 0 and "project dir missing" in err3,
            f"rc3={rc3} err3={err3!r}",
        )


def main():
    test_find_canonical_html()
    test_persist_html()
    test_extract_design()
    test_collage_round_trip()

    print()
    print(f"{len(_passes)} passed, {len(_failures)} failed")
    if _failures:
        for name, detail in _failures:
            print(f"  FAILED: {name}  {detail}")
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Writes desktop/THIRD_PARTY_NOTICES.md from Cargo.lock.

The desktop app is one compiled binary, so what it ships is the closure of
the crate's normal dependencies: build and dev dependencies run on the build
machine and are left out. Cargo resolves that closure from Cargo.lock
(`cargo metadata --locked`), for the two macOS targets the release bundles
(desktop/scripts/bundle-macos.sh). Naming the targets, rather than taking the
host's, keeps the file identical on every machine, Linux CI included.

The policy is the web app's (scripts/third-party-notices.ts): a crate whose
license expression can be satisfied by MIT, ISC or 0BSD alone is listed;
every other crate gets its license and notice files reproduced in full.
Crates that share the same files (the ICU crates, the Symphonia crates) are
reproduced once under one heading, so the file stays readable.

Python, not the web app's TypeScript, because the desktop workflow has a Rust
toolchain and the runners' python3 but no Node or pnpm install.

    scripts/third-party-notices.py          # rewrite the file
    scripts/third-party-notices.py --check  # exit 1 when the file is stale
"""

import json
import os
import re
import subprocess
import sys

DESKTOP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT = os.path.join(DESKTOP, "THIRD_PARTY_NOTICES.md")
TARGETS = ["aarch64-apple-darwin", "x86_64-apple-darwin"]
LISTED_ONLY = {"MIT", "ISC", "0BSD"}
LICENSE_FILE = re.compile(r"^(licen[cs]e|copying|notice|unlicense)", re.IGNORECASE)


def metadata():
    args = ["cargo", "metadata", "--format-version", "1", "--locked"]
    for target in TARGETS:
        args += ["--filter-platform", target]
    out = subprocess.run(args, cwd=DESKTOP, check=True, capture_output=True, text=True)
    return json.loads(out.stdout)


def shipped(meta):
    """The root crate's normal-dependency closure, without the root itself."""
    nodes = {node["id"]: node for node in meta["resolve"]["nodes"]}
    root = meta["resolve"]["root"]
    seen, stack = set(), [root]
    while stack:
        node = stack.pop()
        if node in seen:
            continue
        seen.add(node)
        for dep in nodes[node]["deps"]:
            # kind None is a normal dependency; "build" and "dev" are not shipped.
            if any(kind["kind"] is None for kind in dep["dep_kinds"]):
                stack.append(dep["pkg"])
    seen.discard(root)
    packages = [p for p in meta["packages"] if p["id"] in seen]
    # Code-point order, so no machine's locale changes the file.
    return sorted(packages, key=lambda p: (p["name"], p["version"]))


def tokens(expression):
    # Old crates write "MIT/Apache-2.0" for "MIT OR Apache-2.0".
    return re.findall(r"\(|\)|[^\s()]+", expression.replace("/", " OR "))


def satisfied_by_listed(expression):
    """Whether the SPDX expression can be met with LISTED_ONLY licenses alone.

    Precedence is SPDX's: WITH binds tightest, then AND, then OR. A license
    with an exception (`Apache-2.0 WITH LLVM-exception`) is never listed-only.
    """
    toks = tokens(expression)
    pos = 0

    def peek():
        return toks[pos] if pos < len(toks) else None

    def take():
        nonlocal pos
        pos += 1
        return toks[pos - 1]

    def atom():
        tok = take()
        if tok == "(":
            value = either()
            if take() != ")":
                raise ValueError(f"unbalanced license expression: {expression}")
            return value
        value = tok in LISTED_ONLY
        if peek() == "WITH":
            take()
            take()
            value = False
        return value

    def both():
        value = atom()
        while peek() == "AND":
            take()
            value = atom() and value
        return value

    def either():
        value = both()
        while peek() == "OR":
            take()
            value = both() or value
        return value

    value = either()
    if peek() is not None:
        raise ValueError(f"unparsed license expression: {expression}")
    return value


def license_texts(package):
    """The crate's license and notice files, as (name, text) in name order.

    A crate inside a git workspace (Rune's) may keep its license at the
    repository root, so a git source is searched up to its checkout.
    """
    directory = os.path.dirname(package["manifest_path"])
    stop = directory
    if (package["source"] or "").startswith("git+"):
        while stop != os.path.dirname(stop) and not os.path.exists(os.path.join(stop, ".cargo-ok")):
            stop = os.path.dirname(stop)
    while True:
        names = sorted(n for n in os.listdir(directory) if LICENSE_FILE.match(n))
        if names or directory == stop or directory == os.path.dirname(directory):
            break
        directory = os.path.dirname(directory)
    texts = []
    for name in names:
        with open(os.path.join(directory, name), encoding="utf-8", errors="replace") as f:
            texts.append((name, f.read().rstrip()))
    return texts


def license_of(package):
    if package["license"]:
        return package["license"]
    raise SystemExit(f"{package['name']}@{package['version']} declares no SPDX license")


def render(packages):
    lines = [
        "# Desktop third-party notices",
        "",
        "<!-- Generated by `desktop/scripts/third-party-notices.py`. Do not edit by hand. -->",
        "",
        "The Beadsmith desktop app is MIT licensed (see `LICENSE` at the repository",
        "root; `Beadsmith.app` carries both that file and this one in",
        "`Contents/Resources`). Its macOS binary is built from the Rust crates below: the normal",
        "dependencies in `desktop/Cargo.lock` for `aarch64-apple-darwin` and",
        "`x86_64-apple-darwin`, Rune's included. Build-time and test-only crates are",
        "not part of the binary and are not listed.",
        "",
        "A crate whose license can be met with MIT, ISC or 0BSD alone is listed here;",
        "its license text is in the crate's source. Every other license is",
        "reproduced in full after the table, once for each set of identical files,",
        "or, for a crate that publishes no license file, named with a link to its",
        "standard text and the crate's repository.",
        "",
        "The web app's notices are in the root `THIRD_PARTY_NOTICES.md`.",
        "",
        "| Crate | Version | License |",
        "| --- | --- | --- |",
    ]
    groups = {}
    for package in packages:
        license = license_of(package)
        lines.append(f"| {package['name']} | {package['version']} | {license} |")
        if satisfied_by_listed(license):
            continue
        texts = license_texts(package)
        key = tuple(texts) if texts else ("none", license, package["repository"] or "")
        groups.setdefault(key, []).append(package)

    for key, members in groups.items():
        names = ", ".join(f"{p['name']}@{p['version']}" for p in members)
        licenses = " / ".join(dict.fromkeys(license_of(p) for p in members))
        lines += ["", f"## {names} ({licenses})"]
        if key[0] == "none":
            _, license, repository = key
            lines += [
                "",
                "The published crate includes no license file. The license is",
                f"{license}: https://spdx.org/licenses/{license}.html",
            ]
            if repository:
                lines.append(f"Source: {repository}")
            continue
        for _, text in key:
            lines += ["", "```text", text, "```"]
    return "\n".join(lines) + "\n"


def main():
    packages = shipped(metadata())
    output = render(packages)
    if "--check" in sys.argv[1:]:
        current = ""
        if os.path.exists(OUTPUT):
            with open(OUTPUT, encoding="utf-8") as f:
                current = f.read()
        if current != output:
            print("desktop/THIRD_PARTY_NOTICES.md is stale; run desktop/scripts/third-party-notices.py", file=sys.stderr)
            # Show what differs so a CI-only mismatch is diagnosable from the log.
            have, want = set(current.splitlines()), set(output.splitlines())
            for line in [l for l in output.splitlines() if l not in have][:10]:
                print(f"+ {line}", file=sys.stderr)
            for line in [l for l in current.splitlines() if l not in want][:10]:
                print(f"- {line}", file=sys.stderr)
            sys.exit(1)
        return
    with open(OUTPUT, "w", encoding="utf-8") as f:
        f.write(output)
    print(f"Wrote {len(packages)} crates to desktop/THIRD_PARTY_NOTICES.md")


if __name__ == "__main__":
    main()

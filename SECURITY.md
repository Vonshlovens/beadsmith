# Security Policy

Beadsmith is a self-hosted web UI for Beads issue databases on a Dolt SQL
server. There is no hosted service: you run it. This policy covers how to
report security problems in the Beadsmith source in this repository.

## Reporting a vulnerability

**Please don't open a public issue, discussion or pull request.**

Report vulnerabilities by opening a
[private security advisory](https://github.com/Vonshlovens/beadsmith/security/advisories/new)
on this repository. It keeps the report private until a fix is disclosed.

### What to include

- the commit you tested
- how it was deployed (Compose, the quickstart, the Nix module, from source)
- step-by-step reproduction
- what an attacker gains

## What to expect

We'll confirm we've received your report and keep you updated while we
investigate and fix it. We aim to agree a disclosure date with you, normally
within 90 days of the report.

## Scope

In scope:

- The Beadsmith source code, image and NixOS module in this repository
- Anything that lets someone read or change projects, accounts, backups or
  settings they should not reach, write issue data through Beadsmith, or
  learn the Dolt password or other secrets it holds
  ([security model](README.md#security-model), [contract](docs/contract.md))

Out of scope:

- Other people's deployments of Beadsmith
- The maintainer's own host configuration under `fleet/`, beyond the code
  itself
- Third-party services (Beads, Dolt, Cloudflare, your S3 provider)
- Denial of service
- Scanner output without a working proof of concept

## Supported versions

Beadsmith doesn't publish versioned releases yet. Security fixes land on
`main`; please test against the latest commit before reporting.

## Safe harbour

If you research and report in good faith and follow this policy, we consider
your research authorised. This covers only the Beadsmith project, not
third-party deployments or services.

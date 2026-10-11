# Security policy

## Supported versions

Only the `main` branch and the latest `1.x` version receive security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report it privately through GitHub's private vulnerability reporting:
<https://github.com/gildor853/cardano-block-json/security/advisories/new>
(repository **Security** tab → **Report a vulnerability**).

Please include the affected version, a minimal input (block CBOR or relay
transcript) that reproduces the problem and its impact. You can expect an
acknowledgement within 7 days. Fixes are released as a patch version and
credited in the advisory unless you prefer otherwise.

## Scope

This is a zero-dependency library that decodes untrusted CBOR and talks to
untrusted relays over TCP. Issues such as crashes or hangs on crafted blocks or
relay responses, excessive CPU or memory use, decoding that silently misreports
block contents, bypasses of the private-address (SSRF) guard, and prototype
pollution are in scope. Availability or behaviour of third-party relays is not.

## Disclaimer

This project is provided as is, without warranty. See [DISCLAIMER.md](./DISCLAIMER.md)
for the full disclaimer and limitation of liability.

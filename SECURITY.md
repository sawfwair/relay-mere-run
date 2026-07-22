# Security policy

## Supported versions

Security fixes target the `main` branch and the latest published `mere.run node`
release. Older desktop releases may be asked to upgrade before a fix is
backported.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
[private vulnerability report](https://github.com/sawfwair/relay-mere-run/security/advisories/new).
If that form is unavailable, email `hello@sawfwair.com` with the subject
`[relay-mere-run security]` and avoid including live credentials in the first
message.

Include the affected component and version, impact, reproduction steps or a
minimal proof of concept, and any suggested mitigation. Maintainers will
acknowledge the report, assess severity and scope, coordinate a fix, and credit
the reporter if requested.

## Sensitive data

The repository may name public product services, but it must not contain account
or resource IDs, secret values, access or refresh tokens, customer payloads,
signing keys, production `.env` files, or private deployment artifacts. Rotate a
credential immediately if it is ever committed; deleting the current file is
not sufficient because Git history and pull-request refs retain old content.

# Security policy

Longhand runs with microphone and accessibility permissions, so security reports are taken seriously.

## Reporting a vulnerability

Please do not open a public issue for a security problem.
Report it privately through [GitHub security advisories](https://github.com/ponyo877/longhand/security/advisories/new).

Include what you observed, how to reproduce it, and the version or commit you tested.
You can expect an initial response within a week.

## Scope

Reports are especially welcome for:

- Any network request other than to the LLM endpoint the user configured or the model download the user started
- Transcript text, audio or API keys reaching logs, caches or third parties
- Ways for a web page or another app to make Longhand record, read or paste without the user's action

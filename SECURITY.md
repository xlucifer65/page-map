# Security

Page-Map runs with access to your browser, so security reports matter a lot.

**Please do not open public issues for vulnerabilities.** Use GitHub's
[private vulnerability reporting](../../security/advisories/new) for this repository.

In scope, for example: leaking secret field values, bypassing the blocklist, letting a web page send commands
to the extension or agent, socket/permission problems, supply-chain risks in releases.

## Design guarantees (please help keep them)
- Password / card / one-time-code / API-key values are never read; Luhn-valid card numbers are masked anywhere.
- Blocklisted sites (mail, banks, payments, password managers by default) return nothing.
- Every result is prefixed as untrusted page content (prompt-injection defence).
- Uploads only from allowed folders; hidden, Library and key/secret files are always refused, without revealing whether they exist.
- Local only: per-session unix sockets (0600) in `~/.page-map` (0700); no network listeners.
- Releases are built by CI from tagged `main` commits only.

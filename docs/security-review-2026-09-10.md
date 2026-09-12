# Review: student workflow update

Scope: focused source review of Express authentication, ownership middleware, file delivery, React Markdown rendering, dependencies, and resource use. This is not a penetration test or a guarantee of complete isolation.

## Fixed

1. Low: internal bridge diagnostics prefixed `Codex:` were returned to clients by `publicError` in `server/app.ts`. They now receive a generic error; a regression test verifies private diagnostics do not appear in the response stream.

## Confirmed protections

- API session authentication and chat/file ownership middleware remain enforced.
- Mutations require a custom request header and same-origin checks; cookies are HttpOnly and SameSite Strict, Secure in production.
- Markdown does not enable raw HTML; external images are not fetched and links use noreferrer/noopener.
- API responses use no-store. Only versioned public build assets receive immutable caching.
- Artifact paths reject traversal and symbolic links. Uploaded file delivery now streams through sendFile instead of synchronously loading the entire file into Node memory.
- Production dependency audit: zero reported vulnerabilities on review date.
- 20 automated tests passed, including new study-mode persistence and diagnostic-redaction cases.

## Remaining boundaries

2. Architectural: both accounts use a shared Codex service identity and subscription. HTTP ownership checks do not constitute operating-system isolation between agents. The current design is intended for the owner and trusted users; separate worker identities/containers are required before onboarding untrusted users. Shell network access remains disabled; hosted search has its own access path.

3. Temporary chats use an inactivity-based retention timer and hourly cleanup; native Codex archival is not a verified secure-erasure guarantee. Avoid describing this mode as zero retention.

4. TLS/proxy, backups, host patching, and all third-party dependencies were not subjected to an exhaustive infrastructure audit in this pass. No claim of perfect security is made.

# Security Policy

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security reports.

Instead, use GitHub's [private vulnerability reporting](https://github.com/cresenciof/transcription-tool/security/advisories/new) form on this repository. If that is unavailable, contact the maintainer via `<your-email-or-a-github-form>`.

Include, when possible:
- A description of the issue and its impact.
- Steps to reproduce (a minimal proof-of-concept is ideal).
- Affected version (commit SHA or release tag).
- Your environment (macOS version, chip).

## Scope

In scope:
- The Tauri desktop app (Rust shell, WebView, IPC surface).
- The Python sidecar (`whisper-sidecar`) and its HTTP/SSE API.
- The local build and packaging scripts in this repository.

Out of scope:
- Vulnerabilities in upstream dependencies — please report those to their respective projects (e.g. `mlx-whisper`, `fastapi`, `tauri`). If a vulnerability is exploitable specifically through how this app uses a dependency, that is in scope.
- Model output quality, hallucinations, or transcription accuracy.
- Issues that require physical access to an already-unlocked machine running the app.

## Response expectations

This is a small, personal-first open-source project. Triage and fixes are best-effort:
- Acknowledgement: within 7 days.
- Initial assessment: within 14 days.
- Fix or mitigation: depends on severity and complexity.

No bug bounty is offered.

## Coordinated disclosure

Standard 90-day disclosure window. If you need to disclose earlier (e.g. active exploitation), tell us in the initial report and we will coordinate.

# Contributing to TemperMe

Small, focused improvements and reproducible bug reports are welcome. Start with the [architecture](docs/architecture.md) and [security notes](SECURITY.md), especially for changes to authentication, device selection, or command generation.

## Local development

Use Node.js 22 or later:

```sh
npm ci --ignore-scripts
npm test
npm start
```

Open [http://127.0.0.1:8765](http://127.0.0.1:8765). There is no frontend build step. The server reads the HTML for each page request and reloads the thermostat adapter after file changes; restart for server or network-configuration changes. Restarting clears all signed-in sessions.

The automated suite mocks vendor operations and must stay safe to run without an account, internet access to vendor services, or a physical thermostat. Test files use synthetic account and device fixtures. Do not make default tests send real HVAC commands.

## Changes that are easy to review

Explain the user-visible problem, the resulting behavior, and how you checked the change. Keep unrelated changes separate. For protocol changes, include redacted evidence and a focused regression test that demonstrates the behavior or restriction being protected.

Preserve these boundaries:

- Only the authenticated resident's assigned, supported thermostat is eligible for control.
- Unknown or ambiguous device generations do not acquire controls by guesswork.
- A broker acknowledgment is not device confirmation.
- Fan-only and Off commands do not alter saved temperature targets.
- A temperature-only change preserves the fan setting unless the user explicitly changes it.
- Credentials, raw cloud responses, and device identities do not enter logs, fixtures, media, or Git history.
- LAN sign-in uses HTTPS with exact host/origin checks and a private application upstream.

## UI and documentation

Keep the interface usable with a keyboard and at narrow browser widths. Use plain labels and distinguish requested settings from actual equipment activity. Use synthetic data for screenshots and recordings; see [media provenance](docs/media/README.md).

Document changes to installation, environment variables, compatibility, or command semantics alongside the code. State which behavior was verified on hardware and which was checked through mocks.

## Issues and security reports

For ordinary bugs, include reproducible steps, expected and actual behavior, and sanitized environment details. A model name is useful for compatibility reports; a device identifier is not needed in a public issue.

Follow [SECURITY.md](SECURITY.md) for vulnerabilities and sensitive information. Never attach a live account response, browser profile, packet capture containing credentials, or thermostat label without reviewing and redacting its identifying data.

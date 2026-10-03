# Security and data handling

TemperMe is an independent personal thermostat interface intended to run on one computer or a trusted home LAN. It uses the signed-in resident's existing iApartments cloud permissions. It is not a replacement for the vendor's account security or the thermostat's equipment protections.

## What is stored

| Data | Where it lives |
| --- | --- |
| Resident password | Used transiently during sign-in; TemperMe does not write it to disk. |
| Vendor tokens and Cognito SDK state | Per-browser session in Node process memory. |
| Resident profile and thermostat readings | Node process memory and the active browser page. |
| Local browser session | Random opaque HttpOnly, SameSite=Strict cookie. Secure is added for HTTPS deployment. |
| LAN configuration | A locally created, Git-ignored `.env` file with the server's LAN IP and optional default weather ZIP. |
| Weather ZIP preference | Browser `localStorage` when selected in the UI; an optional server default is configured privately. It remains after signing out until cleared. |
| Weather forecasts and ZIP lookup results | A bounded cache in Node process memory. Restarting clears it. |
| HTTPS certificates and CA private keys | Caddy named Docker volumes. The exported public root certificate belongs in ignored `certificates/`. |

Signing out clears the associated server session. A service restart clears all resident sessions. Idle sessions expire after eight hours, with cleanup checked once per minute. Cloud tokens refresh in memory during an active session.

HTML and JSON responses use `Cache-Control: no-store`; browser requests also request no caching. Only the weather ZIP is saved in `localStorage`, under `temperme_weather_zip`. The UI does not use `sessionStorage`, a service worker, or a resident-data database. Normal application logging excludes credentials, account/device identifiers, profiles, thermostat measurements, and weather locations. Startup logs contain the configured listening address.

These are application-level properties, not a guarantee that a computer leaves no traces. Browser password managers, operating-system memory management, crash dumps, proxies, and administrator tooling are outside TemperMe's control. Treat the host and browser profile as trusted systems.

## Network boundaries

- Native HTTP binds only to loopback by default. Non-loopback HTTP requires the explicit HTTPS-proxy configuration and is intended only for a private proxy upstream.
- The supplied Docker deployment publishes only Caddy's HTTPS port on the selected LAN IP. The application port is not published to the host.
- Exact configured Host and Origin values are checked, and state-changing routes require same-origin JSON requests.
- Caddy's local CA must be trusted on each client before entering credentials. Protect its private keys; only its public root certificate is distributed to clients.
- Device assignment is derived from the authenticated resident profile and rechecked before writes. The browser cannot provide an arbitrary thermostat identifier.
- Multiple browsers have separate sessions. Signing out one browser does not sign out other browsers.

The service needs internet access to Cognito and the iApartments cloud. Optional weather uses fixed Open-Meteo HTTPS endpoints for ZIP lookup and forecasts. The provider receives the requested ZIP or its approximate coordinates and the server's public IP, without resident credentials or device identifiers. Browser geolocation is not used. Open-Meteo describes its own request logging in its [privacy policy](https://open-meteo.com/en/terms#privacy).

Weather requests require a signed-in local session and validate a five-digit US ZIP. Fetches have timeouts, response size limits, concurrency and request limits, and a bounded memory cache. Weather failures do not change thermostat connection status or send thermostat commands.

The bundled configuration does not provide public internet hosting, local offline control, or an account management system. Avoid exposing it through router port forwarding.

## Before sharing a bug report

Include the application version or commit, Node or Docker version, a description of the failure, and sanitized error text. Use synthetic data for reproductions whenever possible.

Do not publish passwords, tokens, cookies, authorization headers, raw cloud responses, resident email addresses, property information, personal weather locations, hub or device identifiers, serial numbers, MAC addresses, private IPs, certificate private keys, `.env` files, browser profiles, or Docker volume archives. Review screenshots and recordings before attaching them.

## Reporting a vulnerability

Use GitHub's **[private vulnerability report](https://github.com/mgelsinger/temperme/security/advisories/new)** for sensitive security findings. Describe the affected behavior, impact, and reproduction with synthetic or redacted data. Do not publish exploit details or account data in an ordinary issue. No response-time guarantee is currently offered.

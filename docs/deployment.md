# Running TemperMe

[Back to the README](../README.md)

TemperMe has two supported deployment paths: Node.js on one computer, or Docker with HTTPS for LAN access. Neither requires a phone app or emulator. Both require an active resident account and the vendor's cloud connection.

## Native Node.js

With Node.js 22 or later installed, run from the repository directory:

```sh
npm ci --ignore-scripts
npm start
```

Open [http://127.0.0.1:8765](http://127.0.0.1:8765). The default service binds to loopback, so that address works only on the computer running it. Use `Ctrl+C` to stop it. Starting it this way does not install a background or startup service.

For a different local port, set `TEMPERME_PORT` before starting. For example, in PowerShell:

```powershell
$env:TEMPERME_PORT = '8766'
npm.cmd start
```

Then use `http://127.0.0.1:8766`. The native service rejects a non-loopback HTTP bind; use the HTTPS deployment below for LAN access.

## Docker and LAN access

### Configure and start

Install Docker with Compose support. Windows users should run Docker Desktop with Linux containers. From the repository directory, copy `.env.example` to `.env`:

```powershell
Copy-Item .env.example .env
```

On macOS or Linux, use `cp .env.example .env`. Edit `.env`:

```dotenv
# Example only. Replace this with an address assigned to the server computer.
TEMPERME_LAN_IP=192.168.1.100
```

Use the computer's LAN IPv4 address, not the thermostat's address, a Docker bridge address, or a VPN address. On Windows, `ipconfig` lists adapter addresses. Prefer a stable address or DHCP reservation if your network allows it.

```sh
docker compose up -d --build
docker compose ps
```

The `app` service should become healthy and `caddy` should be running. Caddy publishes TCP port 9443 only on the configured host address. The Node service has no published host port.

### Trust HTTPS on your computers

The included Caddy configuration creates a local certificate authority for the private LAN address. Browsers need its public root certificate before they can verify the connection. This is the expected [Caddy local HTTPS model](https://caddyserver.com/docs/automatic-https#local-https).

After the containers start, export the **public root certificate** from the Caddy container. In PowerShell:

```powershell
New-Item -ItemType Directory -Force certificates | Out-Null
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./certificates/temperme-root.crt
```

On macOS or Linux:

```sh
mkdir -p certificates
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./certificates/temperme-root.crt
```

Copy that certificate to each client computer over a channel you trust. Only export `root.crt`. Keep the CA's private key and Docker volumes on the server. Verify that a certificate came from your own installation before trusting it.

On Windows, import the certificate for your current user:

```powershell
Import-Certificate -FilePath .\certificates\temperme-root.crt -CertStoreLocation Cert:\CurrentUser\Root
```

Adjust the file path if you copied the certificate elsewhere. This modifies your user's trusted root certificates. On macOS or Linux, import it into the trusted certificate store used by your browser. Some browsers manage their own certificate trust, so check that browser's settings if a warning remains.

Then open `https://YOUR_SERVER_LAN_IP:9443` and sign in. For the sample address above, that is `https://192.168.1.100:9443`. Resolve certificate warnings before entering resident credentials.

The `caddy_data` and `caddy_config` named volumes preserve Caddy's configuration and certificate material across ordinary rebuilds. Do not publish them. Deleting the volumes creates a new CA on the next start and requires replacing the trusted root on clients.

### Day-to-day commands

Run these from the repository directory:

| Task | Command |
| --- | --- |
| Check status | `docker compose ps` |
| View recent service logs | `docker compose logs --tail 50` |
| Stop | `docker compose stop` |
| Start again | `docker compose up -d` |
| Rebuild after a code update | `docker compose up -d --build` |

Containers use `restart: unless-stopped`. The host must be awake and Docker must be running. Resident sessions are memory-only, so restarting or recreating the app container requires signing in again. A page reload by itself does not sign you out.

To update an unmodified checkout:

```sh
git pull --ff-only
docker compose up -d --build
```

For native Node, stop the running process, pull the update, run `npm ci --ignore-scripts`, and start it again. Review upstream changes before applying them to a service that handles your resident account.

### If your LAN address changes

Update `TEMPERME_LAN_IP` in `.env` and run `docker compose up -d`. Open the new HTTPS address. Caddy issues a certificate for the new address under the existing CA, so an intact Caddy data volume avoids repeating root trust setup.

Do not put a resident username, password, token, or device identifier in `.env`. It holds the host's LAN address and, optionally, the default weather ZIP. `.env` and `certificates/` are excluded from Git and from the image build.

## Weather location

After signing in, enter a five-digit US ZIP in the weather banner. The preference stays in that browser until you change it or select **Use host default**. Weather uses no API key or browser location permission. A ZIP chosen in one browser does not change another browser's preference.

For a shared Docker default, add this optional setting to your private `.env` file:

```dotenv
# Example only. Replace with your ZIP, or leave blank to choose in the UI.
TEMPERME_WEATHER_ZIP=12345
```

Run `docker compose up -d` to apply an environment change. Recreating the app clears resident sessions, so sign in again. The public `.env.example` leaves the location blank, and a saved browser ZIP takes priority over the server default.

For native Node, set the environment variable before starting. The native service does not automatically load `.env`. In PowerShell:

```powershell
$env:TEMPERME_WEATHER_ZIP = '12345'
npm.cmd start
```

On macOS or Linux:

```sh
TEMPERME_WEATHER_ZIP=12345 npm start
```

The server needs HTTPS access to `geocoding-api.open-meteo.com` and `api.open-meteo.com`. Weather is optional and has no effect on thermostat operation. Forecasts refresh about every 15 minutes while the page is visible. The included free provider is intended for [personal, non-commercial use](https://open-meteo.com/en/terms).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Browser shows a certificate warning | Trust the root from this installation on this client. Use exactly the address configured in `.env`, with `https://` and port `9443`. |
| Works on the server, not another computer | Check the host firewall for TCP 9443 and whether Wi-Fi client isolation prevents devices from reaching each other. Being on the same Wi-Fi does not always permit peer access. |
| Docker cannot bind the address | Confirm the address belongs to the host's active LAN interface and port 9443 is free. |
| Native startup reports the port is in use | Stop an earlier TemperMe instance or choose another `TEMPERME_PORT`. Do not stop an unrelated service. |
| `npm.ps1` is blocked in PowerShell | Use `npm.cmd ci --ignore-scripts`, `npm.cmd start`, and `npm.cmd test`. |
| Account signs in, but no thermostat appears | Try Refresh readings. Confirm the account has an assigned Gen1 built-in thermostat. A successful login alone does not establish compatible device access. |
| Readings work, but controls are unavailable | The cloud control connection could not be verified. Check internet connectivity, then refresh. Do not reset or re-pair the thermostat to troubleshoot this application. |
| Settings are sent but not confirmed | Wait briefly and refresh. If the device still does not report the requested settings, check the wall display before retrying. |
| Readings are marked stale and controls are disabled | The last cloud read failed. Previous readings remain visible with their original timestamp. Use Refresh readings to recover before sending another command. |
| Automatic refresh is paused | Finish or discard your draft. Polling also pauses while another request runs or the page is hidden. Failures increase the retry interval. |
| Weather cannot find a ZIP | Enter a five-digit US ZIP. Postal codes absent from the provider's location data cannot be resolved. |
| Weather is stale or unavailable | Check internet access to Open-Meteo and try again later. Older forecasts are labeled, and thermostat controls remain independent. |
| Weather shows a different location than the server default | A saved browser ZIP takes priority. Select Use host default in the weather panel to remove that override. |
| Fan still runs after selecting Off | Off sets the fan to Auto. The equipment may retain its normal shutdown delay; compare the fan setting with actual fan activity. |
| Logged out after an update or restart | Expected: cloud tokens and sessions live only in app memory. Reload the page and sign in again. |
| A password reset or account setup is required | Complete the official iApartments account flow, then return to TemperMe. |
| Browser says Invalid host or Same-origin requests are required | Use the configured address. Custom hostnames/proxies must match the exact configured public origins. |

The Compose file creates no router forwarding rules. Keep this deployment on your trusted LAN; the bundled setup is not a public internet hosting configuration.

## Advanced configuration

Most users should leave these values as supplied by the native defaults or Compose file.

| Variable | Purpose |
| --- | --- |
| `TEMPERME_PORT` | Application port, default `8765`; must be from 1024 through 65535. |
| `TEMPERME_BIND_HOST` | Application bind address, default `127.0.0.1`. Compose binds inside the private Docker network. |
| `TEMPERME_HTTPS_PROXY` | Set to `1` only behind a private HTTPS reverse proxy. Enables Secure session cookies and requires explicit HTTPS origins. |
| `TEMPERME_PUBLIC_ORIGINS` | Comma-separated exact allowed origins, with no trailing slash or path. Compose derives this from the LAN IP. |
| `TEMPERME_LAN_IP` | Compose substitution for the host's LAN address; used for HTTPS, port binding, and the permitted origin. |

Custom deployments must preserve the application's private upstream and exact Host/Origin checks. Client-supplied forwarded headers do not establish trust. See [architecture](architecture.md) and [security](../SECURITY.md) before changing that boundary.

# Documentation media

The README screenshots and demonstration show the actual `public/index.html` interface. Every account, reading, command response, and activity indicator in this folder comes from the local synthetic fixture in `scripts/media/demo-server.mjs`. The fixture never imports the cloud adapter and cannot control hardware. It uses `demo@example.com` and sample temperatures, and its content security policy blocks external browser resources and API requests.

| File | Content |
| --- | --- |
| `dashboard.png` | The actual desktop dashboard with cooling selected. |
| `fan-only.png` | Fan only with simulated fan activity and idle heating/cooling. |
| `range.png` | Heating and cooling range controls. |
| `mobile.png` | The actual interface at a 390-pixel phone viewport. |
| `demo.gif` | A looping sequence of actual interface captures. |
| `demo.mp4` | The same 25-second demonstration in H.264 MP4. |
| `hero.svg` | The original conceptual illustration, retained for provenance and no longer used as the README hero. |

The current assets were captured with browser automation in a separate demo tab, using only the synthetic fixture. No production service, resident account, cloud endpoint, thermostat, device identifier, saved credential, or other browser tab was accessed. The page is the product UI without injected presentation graphics. The simulated acknowledgements and activity do not establish physical hardware support.

## Regenerate

Use Node.js 22 or later, `playwright-core`, a locally installed Google Chrome browser, and `ffmpeg` on your PATH. This optional development tooling adds no runtime dependency to TemperMe.

```sh
# Install optional tooling outside this repository.
npm install --prefix /path/to/media-tools playwright-core@1.58.2
node scripts/media/capture.mjs /path/to/media-tools/node_modules/playwright-core/index.mjs
```

The regeneration script launches a fresh headless browser context, binds the synthetic API to a random loopback port, and blocks every browser request outside that fixture. It checks submitted commands and responsive layouts before writing public media to this folder. Set `TEMPERME_MEDIA_BROWSER=msedge` to use a locally installed Microsoft Edge browser instead of Chrome.

For captures made through another browser automation interface, `scripts/media/render-captures.mjs` accepts a manifest of local image captures and durations. It converts them to the four PNG screenshots and 25-second GIF/MP4. Only synthetic captures belong in this public directory. Keep intermediate frames and test reports outside Git, such as in `.local/`.

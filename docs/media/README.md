# Documentation media

Every screenshot and demonstration uses the actual `public/index.html` interface with a local, synthetic API fixture. The account is `demo@example.com`, readings are invented, and the clock is fixed. No production service, resident account, cloud endpoint, thermostat, device identifier, or browser profile was accessed to create these files.

| File | Content |
| --- | --- |
| `hero.svg` | Original vector illustration, not a product screenshot. |
| `dashboard.png` | Desktop cooling controls. |
| `fan-only.png` | Fan only with simulated fan activity and idle heating/cooling. |
| `range.png` | Heating and cooling range controls. |
| `mobile.png` | The responsive interface at a 390-pixel viewport. |
| `demo.gif` | Looping, captioned demonstration. |
| `demo.mp4` | The same 25-second demonstration in H.264 MP4. |

The video and GIF are a sequence of real interface captures. The instructional captions are added only during capture. Device acknowledgements and activity in this demonstration are simulated; they do not establish physical hardware support.

## Regenerate

Use Node.js 22 or later, `playwright-core`, a locally installed Google Chrome browser, and `ffmpeg` on your PATH. The media tooling is optional and does not add a runtime dependency to TemperMe.

```sh
# Install optional tooling outside this repository.
npm install --prefix /path/to/media-tools playwright-core@1.58.2
node scripts/media/capture.mjs /path/to/media-tools/node_modules/playwright-core/index.mjs
```

The capture script launches a fresh headless browser context, binds its demo API to a random loopback port, and blocks browser requests outside that fixture. It checks the three submitted commands, rendered results, mobile horizontal overflow, and browser errors. Temporary frames are removed afterward, and the public media is written to this folder.

Set `TEMPERME_MEDIA_BROWSER=msedge` to use a locally installed Microsoft Edge browser instead of Chrome. The SVG hero is authored directly and does not need regeneration.

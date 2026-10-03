// Encode an explicitly supplied set of synthetic browser captures.
// Input JSON: { stills: [{ source, output }], frames: [{ source, seconds }] }.
// Paths in the manifest are relative to its directory. No cloud service is used.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const outputDirectory = fileURLToPath(new URL('../../docs/media/', import.meta.url));

export async function renderCapturedFrames(manifestPath) {
  const directory = path.dirname(path.resolve(manifestPath));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const inputPath = (name) => {
    assert.match(name, /^[a-z0-9-]+\.(png|jpg)$/i, 'Capture filenames must be simple local image names.');
    return path.join(directory, name);
  };
  const ffmpeg = (args) => {
    const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: directory, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || 'ffmpeg failed');
  };
  for (const still of manifest.stills) {
    assert.match(still.output, /^(dashboard|fan-only|range|mobile)\.png$/);
    ffmpeg(['-i', inputPath(still.source), '-frames:v', '1', '-map_metadata', '-1', path.join(outputDirectory, still.output)]);
  }
  assert.equal(manifest.frames.reduce((sum, frame) => sum + frame.seconds, 0), 25, 'The demonstration is 25 seconds.');
  const concat = [];
  for (const frame of manifest.frames) {
    inputPath(frame.source);
    assert.ok(frame.seconds > 0 && frame.seconds <= 10);
    concat.push(`file '${frame.source}'`, `duration ${frame.seconds}`);
  }
  concat.push(`file '${manifest.frames.at(-1).source}'`);
  await writeFile(path.join(directory, 'frames.txt'), concat.join('\n'));
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', 'frames.txt', '-vf', 'fps=24,pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p', '-t', '25', '-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart', '-map_metadata', '-1', path.join(outputDirectory, 'demo.mp4')]);
  ffmpeg(['-i', path.join(outputDirectory, 'demo.mp4'), '-vf', 'fps=4,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3', '-loop', '0', path.join(outputDirectory, 'demo.gif')]);
  return { captured: ['dashboard.png', 'fan-only.png', 'range.png', 'mobile.png', 'demo.gif', 'demo.mp4'], syntheticDataOnly: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Provide the path to the capture manifest.');
  console.log(JSON.stringify(await renderCapturedFrames(process.argv[2])));
}

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { webpInfo } from '../lib/webp.js';

function encode(args: string[]): Buffer | null {
  const dir = mkdtempSync(join(tmpdir(), 'wa-webp-'));
  try {
    const out = join(dir, 'x.webp');
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, out], { timeout: 20_000 });
    return r.status === 0 ? readFileSync(out) : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('webpInfo', () => {
  test('rejects non-WebP bytes', () => {
    expect(webpInfo(Buffer.from('not a webp image at all, just text'))).toBeNull();
  });

  test('reads size and animation from ffmpeg-made WebPs', () => {
    const still = encode(['-f', 'lavfi', '-i', 'color=red:s=512x512:d=0.1', '-frames:v', '1', '-c:v', 'libwebp']);
    const anim = encode(['-f', 'lavfi', '-i', 'testsrc=s=512x512:r=5:d=1', '-c:v', 'libwebp_anim', '-loop', '0']);
    if (!still || !anim) return; // no ffmpeg with libwebp here
    expect(webpInfo(still)).toEqual({ animated: false, width: 512, height: 512 });
    expect(webpInfo(anim)).toEqual({ animated: true, width: 512, height: 512 });
  });
});

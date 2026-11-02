import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { BLOCKED_DEMO_PHOTO, DEMO_PHOTO_PROFILES } from '../db/demoPhotoProfiles.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const assetDir = path.join(root, 'client/public/images/demo-pets');

describe('demo photo profiles', () => {
  it('maps one distinct, local WebP asset to each verified profile and species', async () => {
    expect(DEMO_PHOTO_PROFILES).toHaveLength(18);
    expect(DEMO_PHOTO_PROFILES.reduce((counts, pet) => ({ ...counts, [pet.species]: (counts[pet.species] ?? 0) + 1 }), {}))
      .toEqual({ dog: 6, cat: 6, hamster: 6 });
    expect(DEMO_PHOTO_PROFILES.some(pet => pet.name === BLOCKED_DEMO_PHOTO.name)).toBe(false);
    expect(new Set(DEMO_PHOTO_PROFILES.map(pet => pet.name)).size).toBe(DEMO_PHOTO_PROFILES.length);

    const signatures = new Set();
    for (const pet of DEMO_PHOTO_PROFILES) {
      expect(pet.filename.endsWith('.webp')).toBe(true);
      expect(pet.sourceUrl.startsWith('https://')).toBe(true);
      const bytes = await fs.readFile(path.join(assetDir, pet.filename));
      const metadata = await sharp(bytes).metadata();
      expect(metadata.format).toBe('webp');
      expect(metadata.width).toBeLessThanOrEqual(1600);
      expect(metadata.height).toBeLessThanOrEqual(1600);
      const signature = bytes.toString('base64');
      expect(signatures.has(signature)).toBe(false);
      signatures.add(signature);
    }
  });
});

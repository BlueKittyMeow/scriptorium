import { describe, it, expect } from 'vitest';
import fs from 'fs';

/**
 * Site icons.
 *
 * The app shipped for months with no favicon at all — browsers drew the blank
 * default page icon. These assert the files exist, that app.html actually
 * points at them, and that the two have the right transparency: the .ico needs
 * cut corners so it sits on any tab strip, while the Apple touch icon must be
 * full-bleed and opaque because iOS applies its own rounding on top.
 */

const APP_HTML = 'src/app.html';

describe('favicon: files are present', () => {
	it('ships a multi-resolution favicon.ico', () => {
		expect(fs.existsSync('static/favicon.ico')).toBe(true);
	});

	it('ships an apple touch icon', () => {
		expect(fs.existsSync('static/apple-touch-icon.png')).toBe(true);
	});

	it('keeps the source artwork out of the served directory', () => {
		// The 1MB generated original is preserved in docs/, not shipped to
		// every visitor from static/.
		expect(fs.existsSync('docs/assets/icon-source.png')).toBe(true);
		expect(fs.existsSync('static/icon-source.png')).toBe(false);
	});
});

describe('favicon: app.html references them', () => {
	const SOURCE = fs.readFileSync(APP_HTML, 'utf-8');

	it('links the icon through the sveltekit assets path', () => {
		expect(SOURCE).toMatch(/<link rel="icon" href="%sveltekit\.assets%\/favicon\.ico"/);
	});

	it('links the apple touch icon', () => {
		expect(SOURCE).toMatch(
			/<link rel="apple-touch-icon" href="%sveltekit\.assets%\/apple-touch-icon\.png"/
		);
	});
});

describe('favicon: the .ico carries the small sizes that actually get drawn', () => {
	it('contains 16, 32 and 48 pixel images', () => {
		// Minimal ICO header parse: bytes 4-5 are the image count, then each
		// 16-byte directory entry starts with width and height (0 means 256).
		const buf = fs.readFileSync('static/favicon.ico');
		expect(buf.readUInt16LE(0)).toBe(0); // reserved
		expect(buf.readUInt16LE(2)).toBe(1); // type 1 = icon
		const count = buf.readUInt16LE(4);
		const sizes: number[] = [];
		for (let i = 0; i < count; i++) {
			sizes.push(buf[6 + i * 16] || 256);
		}
		for (const n of [16, 32, 48]) {
			expect(sizes).toContain(n);
		}
	});
});

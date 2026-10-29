import { describe, it, expect } from 'vitest';
import { sniffAvatar, AVATAR_MAX_BYTES, UPLOAD_NAME } from './companion-profile.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('sniffAvatar', () => {
  it('accepts png, jpg, webp and a plain svg by content', () => {
    expect(sniffAvatar(PNG)).toEqual({ ext: 'png' });
    expect(sniffAvatar(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toEqual({ ext: 'jpg' });
    expect(sniffAvatar(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toEqual({ ext: 'webp' });
    expect(sniffAvatar(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'))).toEqual({ ext: 'svg' });
  });
  it('refuses scripted svg, other types, empty and oversize files', () => {
    expect('error' in sniffAvatar(Buffer.from('<svg><script>alert(1)</script></svg>'))).toBe(true);
    expect('error' in sniffAvatar(Buffer.from('<svg onload="x()"></svg>'))).toBe(true);
    expect('error' in sniffAvatar(Buffer.from('<svg xmlns:svg="http://www.w3.org/2000/svg"><svg:script>alert(1)</svg:script></svg>'))).toBe(true);
    expect('error' in sniffAvatar(Buffer.from('<svg><image href="https://evil.example/x.png"/></svg>'))).toBe(true);
    expect('error' in sniffAvatar(Buffer.from('<svg><use xlink:href="https://evil.example/x.svg#a"/></svg>'))).toBe(true);
    expect(sniffAvatar(Buffer.from('<svg><use href="#local"/><image href="data:image/png;base64,iVBORw0KGgo="/></svg>'))).toEqual({ ext: 'svg' });
    expect('error' in sniffAvatar(Buffer.from('GIF89a'))).toBe(true);
    expect('error' in sniffAvatar(Buffer.alloc(0))).toBe(true);
    expect('error' in sniffAvatar(Buffer.concat([PNG, Buffer.alloc(AVATAR_MAX_BYTES)]))).toBe(true);
  });
  it('only serves names it generated', () => {
    expect(UPLOAD_NAME.test('../../etc/passwd')).toBe(false);
    expect(UPLOAD_NAME.test('0123456789abcdef0123456789abcdef.png')).toBe(true);
  });
});

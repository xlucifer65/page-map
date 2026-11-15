import { describe, it, expect } from 'vitest';
import { hostsDirFor, BROWSERS } from '../../scripts/install-host.js';

describe('hostsDirFor', () => {
  it('maps each browser on macOS', () => {
    const d = (b) => hostsDirFor(b, 'darwin', '/h');
    expect(d('chrome')).toBe('/h/Library/Application Support/Google/Chrome/NativeMessagingHosts');
    expect(d('chromium')).toBe('/h/Library/Application Support/Chromium/NativeMessagingHosts');
    expect(d('brave')).toBe('/h/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts');
    expect(d('edge')).toBe('/h/Library/Application Support/Microsoft Edge/NativeMessagingHosts');
  });
  it('maps each browser on Linux', () => {
    const d = (b) => hostsDirFor(b, 'linux', '/h');
    expect(d('chrome')).toBe('/h/.config/google-chrome/NativeMessagingHosts');
    expect(d('chromium')).toBe('/h/.config/chromium/NativeMessagingHosts');
    expect(d('brave')).toBe('/h/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts');
    expect(d('edge')).toBe('/h/.config/microsoft-edge/NativeMessagingHosts');
  });
  it('defaults to chrome, lists all four, rejects unknown browsers and platforms', () => {
    expect(hostsDirFor(undefined, 'linux', '/h')).toBe(hostsDirFor('chrome', 'linux', '/h'));
    expect(BROWSERS).toEqual(['chrome', 'chromium', 'brave', 'edge']);
    expect(() => hostsDirFor('firefox', 'linux', '/h')).toThrow(/unknown browser/);
    expect(() => hostsDirFor('chrome', 'win32', '/h')).toThrow(/Windows/);
  });
});

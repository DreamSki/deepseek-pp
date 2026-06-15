import { describe, expect, it } from 'vitest';
import { quoteShellArg } from '../core/utils/shell-quote';

describe('quoteShellArg', () => {
  it('keeps command substitutions and quotes literal', () => {
    expect(quoteShellArg(`a'$(touch /tmp/pwn) b`)).toBe(
      `'a'"'"'$(touch /tmp/pwn) b'`,
    );
  });
});

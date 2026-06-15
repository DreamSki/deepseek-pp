import { describe, expect, it } from 'vitest';
import { createShellMcpPresetInput } from '../core/shell/policy';

describe('createShellMcpPresetInput', () => {
  it('defaults Shell MCP to enabled for main agent response logging', () => {
    const preset = createShellMcpPresetInput();

    expect(preset.enabled).toBe(true);
    expect(preset.allowlist).toEqual({ mode: 'allow', toolNames: ['shell_status', 'python_status'] });
    expect(preset.execution).toEqual({ enabled: true, mode: 'manual' });
  });
});


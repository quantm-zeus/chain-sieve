
  run(command: string, args: string[], options: CommandOptions = {}) {
    this.calls.push({ command, args, ...options });
    if (command === 'which' && args[0] === 'agy')
      return { status: 0, stdout: '/usr/local/bin/agy\n', stderr: '' };
    if (command === 'which' && args[0] === 'codex')
      return { status: 0, stdout: '/usr/local/bin/codex\n', stderr: '' };
    if (command === 'which')
      return { status: 1, stdout: '', stderr: 'not found' };
    if (command === 'git' && args.includes('--git-common-dir'))
      return { status: 0, stdout: `${this.common}\n`, stderr: '' };
    return { status: 0, stdout: 'completed\n', stderr: '' };
  }
}

describe('one-command autopilot', () => {
  it('uses the available Antigravity CLI model as the bounded headless default', () => {
    const runner = new RecordingRunner();
    const provider = new AntigravityProvider(runner, {
      applicationCandidates: [],
    });
    expect(DEFAULT_AUTONOMOUS_PROVIDER).toBe('antigravity');
    expect(provider.detect()).toMatchObject({
      available: true,
      mechanism: 'command',
    });
    expect(provider.executePayload('/repo/task', 'bound goal')).toMatchObject({
      status: 0,
    });
    expect(runner.calls.at(-1)).toEqual({
      command: '/usr/local/bin/agy',
      args: [
        '--model',
        DEFAULT_ANTIGRAVITY_AUTOPILOT_MODEL,
        '--mode=accept-edits',
        '--print-timeout',
        DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT,
        '-p',
        'bound goal',
      ],
      cwd: '/repo/task',
      timeoutMilliseconds: 5_400_000,
      streamOutput: false,
    });
  });

  it('keeps Codex as an explicit bounded fallback with global approval disabled', () => {
    const runner = new RecordingRunner();
    const provider = new CodexProvider(runner);
    expect(provider.executePayload('/repo/task', 'bound goal')).toMatchObject({
      status: 0,
    });
    expect(runner.calls.at(-1)).toEqual({
      command: 'codex',
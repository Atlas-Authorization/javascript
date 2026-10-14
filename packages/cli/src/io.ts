/**
 * The two sinks every command writes through, named so tests can capture
 * output instead of spying on `console`. `out` is the data channel (tables,
 * JSON, the answer a script would pipe); `err` is for diagnostics, prompts'
 * echoes and error messages — exactly the stdout/stderr split a `--json`
 * consumer relies on to parse stdout cleanly.
 */
export interface IO {
  out(text: string): void;
  err(text: string): void;
}

/** The real IO: a trailing newline is added so callers pass bare lines. */
export function defaultIO(
  stdout: NodeJS.WriteStream = process.stdout,
  stderr: NodeJS.WriteStream = process.stderr,
): IO {
  return {
    out(text) {
      stdout.write(text + '\n');
    },
    err(text) {
      stderr.write(text + '\n');
    },
  };
}

/** An in-memory IO for tests, exposing the captured lines plus joined views. */
export interface CaptureIO extends IO {
  readonly outLines: string[];
  readonly errLines: string[];
  stdout(): string;
  stderr(): string;
}

export function captureIO(): CaptureIO {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (text) => void outLines.push(text),
    err: (text) => void errLines.push(text),
    stdout: () => outLines.join('\n'),
    stderr: () => errLines.join('\n'),
  };
}

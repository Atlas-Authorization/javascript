import { createInterface } from 'node:readline';

/**
 * The interactive input seam for `atlas login`. An interface (not a direct
 * `readline` call) so tests script answers without a TTY, and so `secret()`
 * can hide the key no matter where it's wired.
 */
export interface Prompter {
  /** A visible line of input, with an optional default shown in brackets. */
  text(query: string, opts?: { default?: string }): Promise<string>;
  /** A hidden line of input — the terminal never echoes what's typed. */
  secret(query: string): Promise<string>;
}

function ask(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, query: string): Promise<string> {
  const rl = createInterface({ input, output });
  return new Promise<string>((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** The real prompter, reading the TTY. Not exercised by unit tests (they inject). */
export function defaultPrompter(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Prompter {
  return {
    async text(query, opts) {
      const suffix = opts?.default ? ` [${opts.default}]` : '';
      const answer = (await ask(input, output, `${query}${suffix}: `)).trim();
      return answer || opts?.default || '';
    },

    secret(query) {
      // Echo the prompt, then mute readline's output so the secret never lands
      // on screen or in scrollback. `_writeToOutput` is readline's own hook;
      // overriding it is the standard way to hide typed input.
      return new Promise<string>((resolve) => {
        const rl = createInterface({ input, output, terminal: true });
        let muted = false;
        const rlInternal = rl as unknown as { _writeToOutput?: (s: string) => void };
        rlInternal._writeToOutput = (s: string) => {
          if (!muted) output.write(s);
        };
        output.write(`${query}: `);
        muted = true;
        rl.question('', (answer) => {
          muted = false;
          output.write('\n');
          rl.close();
          resolve(answer.trim());
        });
      });
    },
  };
}

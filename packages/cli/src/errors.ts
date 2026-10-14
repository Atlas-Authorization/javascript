/**
 * The one error a command handler throws to abort with a clean, user-facing
 * message and a chosen exit code. {@link run} catches it, prints `message` to
 * stderr (no stack), and returns `exitCode` — so a bad flag or a missing key
 * never dumps a stack trace at the terminal the way an uncaught throw would.
 *
 * API failures are NOT CliErrors: they arrive as `AtlasApiError` from
 * `@atlasauth/backend` and {@link run} formats those separately so the stable
 * error `code` and HTTP status survive to the user.
 */
export class CliError extends Error {
  override readonly name = 'CliError';
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
    // Keep `instanceof CliError` working under down-level compile targets.
    Object.setPrototypeOf(this, CliError.prototype);
  }
}

/**
 * Single brand namespace for all user-visible CLI output. Every line is
 * prefixed `[pix]` so logs/errors are unambiguous regardless of which process
 * emitted them.
 */

export function pixLog(message: string): void {
  console.log(`[pix] ${message}`);
}

export function pixErr(message: string): void {
  console.error(`[pix] ${message}`);
}

/**
 * Safe error message extraction utility.
 * Prevents crashes when non-Error values are thrown (e.g. strings, null, undefined).
 */
export function get_error_message(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as Record<string, unknown>).message);
  }
  return 'Unknown error';
}

/**
 * Safely extract a stack trace from an unknown error value.
 */
export function get_error_stack(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.stack;
  }
  return undefined;
}

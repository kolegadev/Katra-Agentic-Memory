/**
 * Escape special regex characters in a string to prevent ReDoS and injection.
 */
export function escape_regex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

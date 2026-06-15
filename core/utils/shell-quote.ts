/** Quote one argument for a POSIX shell without allowing expansion. */
export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

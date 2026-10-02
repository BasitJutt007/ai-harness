// Lint fixture: one console.log (violation), console.error is allowed.
export function handle(input: string): string {
  console.log('debug', input); // VIOLATION no-console
  if (input === '') console.error('empty input');
  return input.trim();
}

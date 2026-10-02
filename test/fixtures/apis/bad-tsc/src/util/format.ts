export function describeValue(input: any): string {
  return String(input);
}

export function firstOf(items: string[]): string {
  return items[0]!;
}

// @ts-ignore
export const suppressed: number = 'not a number';

export const broken: number = 'also not a number';

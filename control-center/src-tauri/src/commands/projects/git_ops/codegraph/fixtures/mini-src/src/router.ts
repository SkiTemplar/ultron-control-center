export function helper(x: number): number {
  return x * 2;
}

export function route(zone: string): number {
  return helper(zone.length);
}

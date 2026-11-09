import { route } from "./router";

export class Dispatcher {
  run(zone: string): number {
    return route(zone) + 1;
  }
}

export function main(): number {
  const d = new Dispatcher();
  return d.run("chat");
}

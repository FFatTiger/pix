import type { RuntimeCapability } from "@fffattiger/pix-runtime-core";
import type { PiRuntimeDriverFactory } from "./types.js";

export interface InternalFactoryInjection {
  driverFactory?: PiRuntimeDriverFactory;
  trace?: { record(step: string): void };
}

const injections = new WeakMap<object, InternalFactoryInjection>();

export function tagFactoryOptions(
  options: { capabilities?: readonly RuntimeCapability[]; reloadCapabilities?: readonly RuntimeCapability[] },
  injection: InternalFactoryInjection,
): void {
  injections.set(options, injection);
}

export function readFactoryInjection(options: object): InternalFactoryInjection | undefined {
  return injections.get(options);
}

import type { HostLogger } from "./types.js";

/** Default logger writing structured lines to the console. */
export const consoleLogger: HostLogger = {
  info(message, fields) {
    console.log(fields ? `${message} ${formatFields(fields)}` : message);
  },
  warn(message, fields) {
    console.warn(fields ? `${message} ${formatFields(fields)}` : message);
  },
  error(message, fields) {
    console.error(fields ? `${message} ${formatFields(fields)}` : message);
  },
  debug(message, fields) {
    if (process.env.PI_WEB_DEBUG) {
      console.debug(fields ? `${message} ${formatFields(fields)}` : message);
    }
  },
};

/** Silent logger for tests. */
export const silentLogger: HostLogger = {};

function formatFields(fields: Record<string, unknown>): string {
  try {
    return JSON.stringify(fields);
  } catch {
    return String(fields);
  }
}

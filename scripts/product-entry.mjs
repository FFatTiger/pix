// B0 deliberately provides product-facing commands before the production
// composition exists. They must fail clearly rather than report false success.

const command = process.argv[2] ?? "unknown";

const plannedOwner = {
  start: "B4 Production Composition + CLI",
  cli: "B4 Production Composition + CLI",
  "test:e2e:startup": "B5 Startup E2E",
}[command];

if (!plannedOwner) {
  console.error(`[pix] unknown bootstrap command: ${command}`);
  process.exitCode = 2;
} else {
  console.error(
    `[pix] ${command} is not available in the B0 workspace baseline; ` +
      `it will be implemented by ${plannedOwner}.`,
  );
  process.exitCode = 1;
}

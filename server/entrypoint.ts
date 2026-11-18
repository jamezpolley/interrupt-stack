// The image's entry point. Tries to move to the newest code on GitHub (see update.ts), runs the server from
// whichever code ended up chosen, passes signals to it, and exits when it exits so the container restarts.
//   INTERRUPT_STACK_REF     branch or tag to follow (default main)
//   INTERRUPT_STACK_UPDATE  "off" to run the code in the image and never consult GitHub
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { supervise } from "./update";

const s = await supervise({
  bakedDir: resolve(import.meta.dir, ".."),
  liveDir: join(tmpdir(), "interrupt-stack-live"),
  dataDir: process.env.DATA_DIR ?? "/data",
  ref: process.env.INTERRUPT_STACK_REF || "main",
  port: Number(process.env.PORT ?? 9958),
  update: process.env.INTERRUPT_STACK_UPDATE !== "off",
});

for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => s.child.kill(sig));
process.exit((await s.child.exited) ?? 1);

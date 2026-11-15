import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  // No test may reach a real provider: a key in the shell that runs the tests is blanked here, and tests that need one set a made-up value.
  test: { include: ["tests/**/*.test.ts"], environment: "node", env: { OPENAI_API_KEY: "", BROADSIDE_IMAGE_MODEL: "", BROADSIDE_IMAGE_DAILY_LIMIT: "" } },
});

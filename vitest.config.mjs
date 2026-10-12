import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Same "@/..." alias jsconfig.json gives the Next.js build, so the tests
      // import the real modules rather than copies.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Error monitoring is a no-op in tests (tests/helpers/sentry-stub.js).
      "@sentry/nextjs": fileURLToPath(new URL("./tests/helpers/sentry-stub.js", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
  },
});

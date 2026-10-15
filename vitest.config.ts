import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["src/jsdom-setup.ts"],
  },
});

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const apiOrigin = process.env.AUTORESEARCH_DASHBOARD_API_ORIGIN ?? "http://127.0.0.1:4312";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  plugins: [react()],
  server: {
    proxy: {
      "/trpc": {
        target: apiOrigin,
        changeOrigin: true,
      },
    },
  },
});

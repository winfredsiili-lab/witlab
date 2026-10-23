import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the browser calls /api on the Vite server, which proxies to the Express API.
// This avoids CORS issues locally and keeps the API address out of component code.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});

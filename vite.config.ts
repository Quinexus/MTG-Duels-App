import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/archidekt-api": {
        target: "https://archidekt.com/api",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/archidekt-api/, ""),
      },
      "/moxfield-api": {
        target: "https://api2.moxfield.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/moxfield-api/, ""),
      },
    },
  },
});

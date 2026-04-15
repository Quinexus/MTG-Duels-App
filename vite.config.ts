import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/archidekt-api": {
        target: "https://archidekt.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/archidekt-api/, "/api"),
      },
      "/moxfield-api": {
        target: "https://api2.moxfield.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/moxfield-api/, ""),
      },
    },
  },
});

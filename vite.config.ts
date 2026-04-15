import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/archidekt": {
        target: "https://archidekt.com",
        changeOrigin: true,
        rewrite: (path) => ensureTrailingSlash(path.replace(/^\/api\/archidekt/, "/api")),
      },
      "/archidekt-api": {
        target: "https://archidekt.com",
        changeOrigin: true,
        rewrite: (path) => ensureTrailingSlash(path.replace(/^\/archidekt-api/, "/api")),
      },
      "/moxfield-api": {
        target: "https://api2.moxfield.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/moxfield-api/, ""),
      },
    },
  },
});

function ensureTrailingSlash(path: string) {
  const [pathname, query = ""] = path.split("?");
  const normalized = pathname.endsWith("/") ? pathname : `${pathname}/`;
  return query ? `${normalized}?${query}` : normalized;
}

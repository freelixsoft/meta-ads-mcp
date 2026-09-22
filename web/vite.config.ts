import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * The app is served from /dashboard by the Express server, so `base` must
 * match or the emitted asset URLs resolve against the wrong prefix.
 *
 * In dev, Vite itself serves /dashboard (that is what `base` does), so
 * /dashboard is NOT proxied — proxying it would hand the route to Express,
 * which has no build to serve and would break hot reload. Everything the SPA
 * actually needs from the server — the API and the whole auth surface — is
 * proxied, so the browser only ever talks to one origin and the session
 * cookie (SameSite=Lax, host-only on localhost, which ignores the port)
 * attaches to every request.
 */
export default defineConfig({
  base: "/dashboard/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        // Recharts is over half the bundle and changes far less often than the
        // app code, so it gets its own immutable chunk and survives a dashboard
        // deploy in the browser cache. React is left in the entry chunk: the
        // JSX runtime import makes a separate react chunk come out empty.
        manualChunks: {
          charts: ["recharts"],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: false },
      "/auth": { target: "http://localhost:3000", changeOrigin: false },
      "/authorize": { target: "http://localhost:3000", changeOrigin: false },
    },
  },
});

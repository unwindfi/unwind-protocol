import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // The market list is shared with the server rather than copied. Mints,
      // feed ids and risk params have to agree in both places or the deployed
      // page quotes a different market than the program does.
      "@scripts": path.resolve(__dirname, "../scripts"),
    },
  },
  // Locally the build lands in the Express server's static root, so one process
  // serves both the app and the API. On Vercel there is no Express server to
  // serve into, so it builds to the default `dist` the platform expects.
  //
  // Vercel builds twice: the public waitlist into `dist`, then the whole
  // site with `VITE_UNLOCK=1` into `dist/unlocked`, which the middleware only
  // serves behind the `/code` password. The public folder is already there
  // from the first pass, and its files are fetched from the root either way.
  base: process.env.VERCEL && process.env.VITE_UNLOCK === "1" ? "/unlocked/" : "/",
  build: !process.env.VERCEL
    ? { outDir: "../app", emptyOutDir: false }
    : process.env.VITE_UNLOCK === "1"
      ? { outDir: "dist/unlocked", emptyOutDir: false, copyPublicDir: false }
      : { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    // `../scripts` is outside the Vite root, so dev has to be told it is fair
    // game; the build resolves it through the alias regardless.
    fs: { allow: [path.resolve(__dirname, "..")] },
    /*
     * Only the API is proxied.
     *
     * `/logos` used to go to the same server, which meant every market's
     * artwork 502'd whenever that server was not up and the whole site fell
     * back to letter monograms -- while the very same files sat in `public`,
     * where Vite would have served them. The server has no logo route of its
     * own; it serves them as static files out of the build, which is where
     * these end up anyway. So this now matches production, and the site draws
     * its logos with no server running at all.
     */
    // `API_PROXY` points the dev site at another server, such as the live
    // testnet, to try the site against real devnet state without running one.
    proxy: {
      "/api": { target: process.env.API_PROXY ?? "http://localhost:3000", changeOrigin: true },
    },
  },
});

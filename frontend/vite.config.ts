import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server on http://localhost:5173. The API base URL comes from VITE_API_BASE_URL
// (see frontend/.env.example); the backend must allow this origin via CORS_ORIGINS.
export default defineConfig({
  plugins: [react()],
  server: { host: "localhost", port: 5173, strictPort: true },
  preview: { host: "localhost", port: 4173 },
});

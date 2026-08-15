import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "@/routes/router";

// UX2-F: pi-web-desktop font foundation — iA Writer Quattro (UI) and
// Lilex (code). Same faces and weights the reference app loads in
// app/layout.tsx: 400 (default import), 400-italic, 700, 700-italic.
import "@fontsource/ia-writer-quattro";
import "@fontsource/ia-writer-quattro/400-italic.css";
import "@fontsource/ia-writer-quattro/700.css";
import "@fontsource/ia-writer-quattro/700-italic.css";
import "@fontsource/lilex";

import "@/styles/app.css";

const el = document.getElementById("root");
if (!el) {
  throw new Error("Root element #root not found");
}

createRoot(el).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);

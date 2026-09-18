import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "@/routes/router";
import "katex/dist/katex.min.css";
import "@/styles/globals.css";
import "@/styles/pix-adapter.css";
import "@fontsource/lilex";

const el = document.getElementById("root");
if (!el) {
  throw new Error("Root element #root not found");
}

createRoot(el).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);

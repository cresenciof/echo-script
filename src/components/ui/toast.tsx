/**
 * Toast surface for the app.
 *
 * We standardize on `sonner` for all notifications. The shadcn/ui Radix toast
 * primitives are also installed (kept available for future inline use), but
 * everything app-facing should flow through this re-export so the design
 * agent can theme it in one place.
 */
export { Toaster, toast } from "sonner";

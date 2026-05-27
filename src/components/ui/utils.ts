/**
 * Convenience re-export.
 *
 * The canonical home of `cn` is `@/lib/utils`. We re-export here so existing
 * shadcn/ui snippets that import `cn` from `./utils` (relative to the ui
 * folder) keep working without modification.
 */
export { cn } from "@/lib/utils";

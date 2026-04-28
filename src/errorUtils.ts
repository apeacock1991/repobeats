export function getErrorMessage(error: unknown, fallback = "Unexpected server error."): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return fallback;
}

export function getErrorStackPreview(error: unknown, maxChars = 800): string | undefined {
  if (!(error instanceof Error) || typeof error.stack !== "string") return undefined;
  return error.stack.slice(0, maxChars);
}

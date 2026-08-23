/**
 * Id of the wrapper around the app-wide sonner <Toaster> (see app/layout.tsx).
 *
 * The desktop photo viewer inerts every other <body> child while it is open;
 * this one is exempt so toasts stay visible and operable — including the ones
 * the viewer itself fires.
 */
export const TOAST_REGION_ID = "toast-region";

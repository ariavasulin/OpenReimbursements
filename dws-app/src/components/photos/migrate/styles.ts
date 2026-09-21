// Class strings for the import screens. The app's existing dark palette, sized to the
// standing rules: touch targets at least 44px (min-h-11), body and form text at least 16px.
// Buttons may wrap their label, so they survive browser text at 200% on a narrow phone.

const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2680FC]';

export const button =
  `inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[#555] px-4 py-2 text-left text-base font-medium text-white hover:bg-[#444] disabled:opacity-40 ${focus}`;
export const primaryButton =
  `inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-transparent bg-[#2680FC] px-5 py-2 text-base font-semibold text-white hover:bg-[#1a6fd8] disabled:opacity-40 ${focus}`;
export const quietButton =
  `inline-flex min-h-11 items-center gap-2 rounded-lg px-2 py-2 text-left text-base text-[#8bbaff] underline underline-offset-2 hover:text-white disabled:opacity-40 ${focus}`;
export const dangerButton = `${button} text-red-300`;
/** A control that opens a list: its value reads from the left like a text field, with the chevron at the far edge. */
export const chooserButton =
  `flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-[#555] bg-[#222222] px-3 py-2 text-left text-base text-white hover:bg-[#2c2c2c] disabled:opacity-40 ${focus}`;
export const field =
  'min-h-11 w-full rounded-lg border border-[#555] bg-[#222222] px-3 py-2 text-base text-white placeholder:text-[#a8a8a8] focus:border-[#2680FC] focus:outline-none disabled:opacity-60';
export const label = 'block text-base font-medium text-white';
/** Secondary text: deliberately readable on the dark background, never below 16px for sentences. */
export const hint = 'text-base leading-6 text-[#c4c4c4]';
export const card = 'rounded-xl bg-[#2e2e2e] p-4';

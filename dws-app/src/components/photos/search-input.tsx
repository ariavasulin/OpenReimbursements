"use client";

export default function SearchInput({
  value,
  onChange,
  onSubmit,
  className = "mb-2 py-2.5",
}: {
  value: string;
  onChange(value: string): void;
  /** Enter pressed. */
  onSubmit(): void;
  /** Padding and margin only — the rest of the look is fixed. */
  className?: string;
}) {
  return (
    <input
      type="search"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSubmit();
      }}
      placeholder="Search jobs, people, or tags..."
      // The focus indicator is the ring, not the border tint: #2680FC on the
      // field's own #3e3e3e is 2.84:1, under the 3:1 WCAG 1.4.11 asks of a
      // non-text indicator. The ring sits on the #222222 page: 4.22:1.
      className={`w-full rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-3 text-base text-white md:text-sm placeholder:text-[#a0a0a0] focus:border-[#2680FC] focus:outline-none focus:ring-2 focus:ring-[#2680FC] ${className}`}
    />
  );
}

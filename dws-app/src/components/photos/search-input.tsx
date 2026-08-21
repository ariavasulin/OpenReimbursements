"use client";

export default function SearchInput({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange(value: string): void;
  /** Enter pressed. */
  onSubmit(): void;
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
      className="mb-2 w-full rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-3 py-2.5 text-sm text-white placeholder:text-[#a0a0a0] focus:border-[#2680FC] focus:outline-none"
    />
  );
}

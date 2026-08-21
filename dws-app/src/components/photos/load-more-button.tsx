"use client";

export default function LoadMoreButton({
  onClick,
  loading,
}: {
  onClick(): void;
  loading: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="mt-4 w-full rounded-lg border border-[#4e4e4e] bg-[#2e2e2e] py-2.5 text-sm text-white hover:border-[#2680FC]"
    >
      {loading ? "Loading..." : "Load more"}
    </button>
  );
}

"use client";

export default function LoadMoreButton({
  onClick,
  loading,
  retry = false,
}: {
  onClick(): void;
  loading: boolean;
  /** The last attempt failed, so this click is the retry. */
  retry?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="mt-4 block w-full rounded-lg border border-[#4e4e4e] bg-[#2e2e2e] py-2.5 text-sm text-white hover:border-[#2680FC] desktop:mx-auto desktop:w-auto desktop:px-8"
    >
      {loading ? "Loading..." : retry ? "Try again" : "Load more"}
    </button>
  );
}

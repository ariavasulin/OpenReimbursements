// One screen for every link that does not work: never existed, turned off, or share pages switched
// off for everyone. It says the same thing for all of them on purpose (photo-albums AC-22), so it
// cannot be used to tell a real link from a guess.
export default function SharedNotFound() {
  return (
    <main className="flex h-dvh items-center justify-center overflow-y-auto bg-[#222222] px-6 text-white">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-semibold">This link is not available</h1>
        <p className="mt-3 text-base leading-7 text-[#c4c4c4]">It may have been turned off. Ask the person who sent it to you for a new link.</p>
      </div>
    </main>
  );
}

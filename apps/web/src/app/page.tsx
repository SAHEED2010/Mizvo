export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center px-6 py-20 sm:px-10">
      <p className="mb-5 text-sm font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
        Mizvo
      </p>
      <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-6xl">
        Business clarity. Financial growth.
      </h1>
      <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-600">
        A workspace for Nigerian businesses to understand their records and make informed decisions.
        The application scaffold is ready; account and financial features are being designed next.
      </p>
      <div className="mt-10 inline-flex w-fit items-center gap-3 rounded-full border border-emerald-900/15 bg-white px-4 py-2 text-sm text-slate-700 shadow-sm">
        <span className="size-2 rounded-full bg-[var(--accent)]" aria-hidden="true" />
        Development scaffold
      </div>
    </main>
  );
}

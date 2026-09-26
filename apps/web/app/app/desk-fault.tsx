"use client";

/**
 * The desk layer refusing to start, said in its own words.
 *
 * Deliberately not phrased as "unreachable": nothing was unreachable. The app is deployed without
 * the configuration it needs, which is a different problem with a different fix, and the server
 * already wrote the sentence that names it.
 *
 * Its own module because a Next route file may only export the handful of names the framework
 * knows; a shared component living in one would fail the build rather than the review.
 */
export function DeskFault({ message }: { message: string }) {
  return (
    <div className="panel desk-fault" role="alert">
      <div className="sec-head">
        <h2>The desk is not configured</h2>
        <span className="label">Deployment</span>
      </div>
      <p className="note">{message}</p>
      <p className="note">
        Nothing downstream of this was asked — the relayer, the chains and any client&rsquo;s authority are all
        unknown rather than empty. See <span className="mono">DEPLOY.md</span>.
      </p>
    </div>
  );
}

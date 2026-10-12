/**
 * The page DOM an archive recorded, as HTML texts, whichever recorder ran: the capture agent's
 * raw DOM snapshots (`dom.snapshot` blobs, source "html") and the rrweb log (`dom.rrweb.event`)
 * rebuilt by player-sdk at each of its full snapshots and at its last event.
 *
 * @param {{ query(): any[]; getBlob(hash: string): Promise<{ bytes: Uint8Array } | null> }} player
 * @param {{ RrwebDomReplay: any; renderDomSubtree: Function }} sdk player-sdk's module
 * @returns {Promise<{ texts: string[]; htmlSnapshots: number; rrwebSnapshots: number; rrwebMutations: number }>}
 */
export async function recordedDomTexts(player, sdk) {
  const events = player.query();
  const htmlSnapshots = events.filter(
    (event) => event.type === "dom.snapshot" && event.data?.source === "html"
  );
  const htmlTexts = await Promise.all(
    htmlSnapshots.map(async (event) => {
      const blob = await player.getBlob(event.data?.contentHash ?? "");
      return blob ? new TextDecoder().decode(blob.bytes) : "";
    })
  );
  const replay = sdk.RrwebDomReplay.fromEvents(events);
  const { entries, fullSnapshots } = replay.timeline;
  const moments = [
    ...fullSnapshots.map((index) => entries[index].mono),
    ...(entries.length > 0 ? [entries.at(-1).mono] : [])
  ];
  const rrwebTexts = moments.flatMap((mono) => {
    const state = replay.domAt(mono);
    return state?.tree.rootId == null
      ? []
      : [
          sdk.renderDomSubtree(state.tree, state.tree.rootId, {
            depth: 500,
            maxBytes: 4_000_000,
            maxTextChars: 10_000,
            collapseHead: false
          }).content
        ];
  });

  return {
    texts: [...htmlTexts, ...rrwebTexts],
    htmlSnapshots: htmlSnapshots.length,
    rrwebSnapshots: fullSnapshots.length,
    // rrweb `IncrementalSource.Mutation` events: the change log of the page.
    rrwebMutations: entries.filter(
      (entry) => entry.event.type === 3 && entry.event.data?.source === 0
    ).length
  };
}

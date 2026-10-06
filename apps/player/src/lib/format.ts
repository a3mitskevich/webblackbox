export function formatTimelineEventLabel(eventId: string): string {
  const exactMatch = /^E-(\d+)$/.exec(eventId);
  const anyNumber = /(\d+)(?!.*\d)/.exec(eventId);
  const digits = exactMatch?.[1] ?? anyNumber?.[1];

  if (!digits) {
    return eventId;
  }

  return `#${digits.slice(-5).padStart(5, "0")}`;
}

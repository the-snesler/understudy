/**
 * Daily time windows such as "23:00-07:00, 12:30-13:00", evaluated in an IANA time zone. A window
 * whose end is before its start runs past midnight.
 */

export interface TimeWindow {
  /** Minutes after midnight. */
  start: number;
  end: number;
}

const WINDOW = /^(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})$/;

export function parseWindows(text: string): TimeWindow[] {
  const parts = text
    .split(/[,;\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.map((part) => {
    const m = WINDOW.exec(part);
    const nums = m?.slice(1).map(Number);
    if (!nums || nums[0]! > 23 || nums[2]! > 24 || nums[1]! > 59 || nums[3]! > 59) {
      throw new Error(`"${part}" is not a time range like 23:00-07:00`);
    }
    return { start: nums[0]! * 60 + nums[1]!, end: nums[2]! * 60 + nums[3]! };
  });
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Minutes after local midnight in `timeZone`. Uses ICU, so it works without system tzdata. */
export function minutesInZone(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}

export function inWindows(windows: TimeWindow[], minutes: number): boolean {
  return windows.some((w) => (w.start <= w.end ? minutes >= w.start && minutes < w.end : minutes >= w.start || minutes < w.end));
}

export function defaultTimeZone(): string {
  return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

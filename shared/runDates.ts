import type { RunningRecord } from "./types";

export const DEFAULT_RUN_TIME_ZONE = "Asia/Shanghai";

const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = dateFormatters.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  dateFormatters.set(timeZone, formatter);
  return formatter;
}

export function calendarDateFromDateTime(dateTime: string, timeZone = DEFAULT_RUN_TIME_ZONE): string {
  const date = new Date(dateTime);
  if (Number.isNaN(date.getTime())) return dateTime.slice(0, 10);
  const parts = dateFormatter(timeZone).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : dateTime.slice(0, 10);
}

export function runLocalDate(run: Pick<RunningRecord, "dateTime" | "localDate">): string {
  if (run.localDate && calendarDatePattern.test(run.localDate)) return run.localDate;
  return calendarDateFromDateTime(run.dateTime);
}

export function runLocalMonth(run: Pick<RunningRecord, "dateTime" | "localDate">): string {
  return runLocalDate(run).slice(0, 7);
}

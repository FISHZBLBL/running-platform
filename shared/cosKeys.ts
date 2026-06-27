const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;

export function normalizeUsername(username: string): string {
  return username.trim();
}

export function isValidUsername(username: string): boolean {
  return USERNAME_PATTERN.test(username);
}

export function userPrefix(username: string): string {
  return `users/${normalizeUsername(username)}/`;
}

export function profileKey(username: string): string {
  return `${userPrefix(username)}profile.json`;
}

export function keepKey(username: string): string {
  return `${userPrefix(username)}.keep`;
}

export function runKey(username: string, runId: string): string {
  return `${userPrefix(username)}runs/${runId}.json`;
}

export function runsPrefix(username: string): string {
  return `${userPrefix(username)}runs/`;
}

export function screenshotKey(username: string, runId: string, fileId: string, extension: string): string {
  const safeExt = extension.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "bin";
  return `${userPrefix(username)}runs/${runId}/screenshots/${fileId}.${safeExt}`;
}

export function shoeKey(username: string, shoeId: string): string {
  return `${userPrefix(username)}shoes/${shoeId}.json`;
}

export function shoesPrefix(username: string): string {
  return `${userPrefix(username)}shoes/`;
}

export function shoePhotoKey(username: string, shoeId: string, fileId: string, extension: string): string {
  const safeExt = extension.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "jpg";
  return `${userPrefix(username)}shoes/${shoeId}/photos/${fileId}.${safeExt}`;
}

export function weightKey(username: string, date: string): string {
  return `${userPrefix(username)}weights/${date}.json`;
}

export function weightsPrefix(username: string): string {
  return `${userPrefix(username)}weights/`;
}

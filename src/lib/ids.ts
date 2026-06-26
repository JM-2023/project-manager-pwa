export function newId(): string {
  return crypto.randomUUID();
}

export function newMutationId(): string {
  return `mut_${crypto.randomUUID()}`;
}

export function getOrCreateClientId(): string {
  const key = "project-manager-client-id";
  const existing = localStorage.getItem(key);
  if (existing) {
    return existing;
  }

  const next = crypto.randomUUID();
  localStorage.setItem(key, next);
  return next;
}

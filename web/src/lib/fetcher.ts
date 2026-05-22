export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function fetcher<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try {
      const j = await r.json();
      if (j?.error) detail = j.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(r.status, detail);
  }
  return r.json() as Promise<T>;
}

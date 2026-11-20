import { timingSafeEqual } from 'node:crypto';

export function validHttpToken(value: string | undefined): value is string {
  return !!value && /^[A-Za-z0-9_-]{32,}$/.test(value);
}

/** Native clients omit Origin. Refuse browser requests before checking credentials. */
export function httpRequestStatus(rawHeaders: string[], port: number, token: string): 200 | 401 | 403 {
  const values = (name: string) => {
    const found: string[] = [];
    for (let i = 0; i < rawHeaders.length; i += 2) {
      if (rawHeaders[i].toLowerCase() === name) found.push(rawHeaders[i + 1]);
    }
    return found;
  };
  const hosts = values('host');
  if (hosts.length !== 1 || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(hosts[0]) || values('origin').length) {
    return 403;
  }
  const auth = values('authorization');
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(auth[0] ?? '');
  return auth.length === 1 && actual.length === expected.length && timingSafeEqual(actual, expected) ? 200 : 401;
}

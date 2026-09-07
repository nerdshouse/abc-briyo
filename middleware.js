import { NextResponse } from 'next/server';

/**
 * HTTP Basic Auth guard for the dashboard page and the data API.
 * This runs server-side at the edge, before any page or route handler, so the
 * PII in /api/carts is never reachable without credentials.
 *
 * The webhook route is deliberately NOT matched — it has its own shared-secret
 * auth and GoKwik cannot send Basic Auth headers.
 */
export function middleware(request) {
  const user = process.env.DASHBOARD_USER;
  const pass = process.env.DASHBOARD_PASS;

  if (!user || !pass) {
    return new NextResponse('Dashboard credentials are not configured.', { status: 500 });
  }

  const header = request.headers.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    let decoded = '';
    try {
      decoded = atob(header.slice(6));
    } catch {
      decoded = '';
    }
    const sep = decoded.indexOf(':');
    if (sep !== -1) {
      const givenUser = decoded.slice(0, sep);
      const givenPass = decoded.slice(sep + 1);
      if (givenUser === user && givenPass === pass) {
        return NextResponse.next();
      }
    }
  }

  return new NextResponse('Authentication required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Briyo Abandoned Carts", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ['/', '/api/carts'],
};

import test from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';
import { refuseForeignRequest, refuseUnknownHost } from '../src/lib/server/guard';

/** The guard only reads headers, so a request is stood in for by its headers. */
const request = (headers: Record<string, string>) => ({ headers: new Headers(headers) }) as unknown as NextRequest;
const json = { 'content-type': 'application/json' };

test('the office answers when addressed as this computer', () => {
  for (const host of ['localhost', 'localhost:3000', '127.0.0.1:3000', '[::1]:3000', 'LOCALHOST:3000']) {
    assert.equal(refuseUnknownHost(request({ host })), null, host);
  }
});

test('any other host name is refused, which stops DNS rebinding', () => {
  for (const host of ['evil.example', 'evil.example:3000', '192.168.1.20:3000', 'localhost.evil.example', '127.0.0.1.evil.example:3000', '0.0.0.0:3000']) {
    assert.equal(refuseUnknownHost(request({ host }))?.status, 403, host);
  }
  assert.equal(refuseUnknownHost(request({}))?.status, 403, 'no Host header');
});

test('OFFICE_ALLOWED_HOSTS adds host names and nothing else', () => {
  process.env.OFFICE_ALLOWED_HOSTS = 'office.example.internal, Other.Example';
  try {
    assert.equal(refuseUnknownHost(request({ host: 'office.example.internal:8443' })), null);
    assert.equal(refuseUnknownHost(request({ host: 'other.example' })), null);
    assert.equal(refuseUnknownHost(request({ host: 'evil.example' }))?.status, 403);
  } finally {
    delete process.env.OFFICE_ALLOWED_HOSTS;
  }
});

test('a change is accepted from the office page and from scripts on this computer', () => {
  assert.equal(refuseForeignRequest(request({ host: 'localhost:3000', origin: 'http://localhost:3000', ...json })), null);
  // curl and other scripts send no Origin
  assert.equal(refuseForeignRequest(request({ host: '127.0.0.1:3000', ...json })), null);
  assert.equal(refuseForeignRequest(request({ host: 'localhost:3000', 'content-type': 'application/json; charset=utf-8' })), null);
});

test('a change from another site is refused', () => {
  const origins = [
    'https://evil.example',
    // the preview of a project runs on another local port
    'http://localhost:4000',
    'http://127.0.0.1:3000',
    // a sandboxed page
    'null',
  ];
  for (const origin of origins) {
    assert.equal(refuseForeignRequest(request({ host: 'localhost:3000', origin, ...json }))?.status, 403, origin);
  }
});

test('a change must be sent as JSON, which a form on another site cannot do', () => {
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    assert.equal(refuseForeignRequest(request({ host: 'localhost:3000', 'content-type': type }))?.status, 415, type);
  }
  assert.equal(refuseForeignRequest(request({ host: 'localhost:3000' }))?.status, 415, 'no content type');
});

test('a change addressed to an unknown host is refused before anything else', () => {
  assert.equal(refuseForeignRequest(request({ host: 'evil.example', origin: 'http://evil.example', ...json }))?.status, 403);
});

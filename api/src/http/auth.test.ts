import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { checkPassword, readCookie, validateInitData } from './auth.service';

const TOKEN = '123456:ABC-test';
function sign(fields: Record<string, string>, token = TOKEN) {
  const check = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') }).toString();
}
const now = Date.now();
const fields = (id = 42, age = 60) => ({ auth_date: String(Math.floor(now / 1000) - age), query_id: 'AAH', user: JSON.stringify({ id, first_name: 'Randy' }) });

test('valid initData for allowed user', () => assert.equal(validateInitData(sign(fields()), TOKEN, '42', now), true));
test('wrong user', () => assert.equal(validateInitData(sign(fields(7)), TOKEN, '42', now), false));
test('expired', () => assert.equal(validateInitData(sign(fields(42, 90000)), TOKEN, '42', now), false));
test('bad signature / other bot', () => assert.equal(validateInitData(sign(fields(), '999:x'), TOKEN, '42', now), false));
test('tampered', () => assert.equal(validateInitData(sign(fields()).replace('Randy', 'Eve'), TOKEN, '42', now), false));
test('no hash', () => assert.equal(validateInitData('user=%7B%7D', TOKEN, '42', now), false));
test('readCookie', () => assert.equal(readCookie('a=1; plata_session=xyz; b=2', 'plata_session'), 'xyz'));
test('checkPassword', () => {
  assert.equal(checkPassword('s3cret', 's3cret'), true);
  assert.equal(checkPassword('nope', 's3cret'), false);
  assert.equal(checkPassword('', ''), false); // unset env = disabled
  assert.equal(checkPassword(undefined, 's3cret'), false);
  assert.equal(checkPassword(123, '123'), false);
});

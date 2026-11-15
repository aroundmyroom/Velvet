import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('final coordinator fixes', () => {
  it('the admin page signs out when another tab broadcasts logout', () => {
    const listeners = [];
    const assigned = [];
    class FakeChannel {
      addEventListener(type, fn) { if (type === 'message') listeners.push(fn); }
      postMessage() {}
    }
    const ctx = {
      BroadcastChannel: FakeChannel,
      localStorage: { getItem: () => null, removeItem() {} },
      Cookies: { remove() {} },
      axios: { create: () => ({ interceptors: { request: { use() {} } } }) },
      document: { location: { assign: url => assigned.push(url) } },
      window: { location: { origin: 'https://v.example' } },
    };
    // eslint-disable-next-line sonarjs/code-eval -- runs our own browser file in a sandbox
    vm.runInNewContext(read('webapp/assets/js/api.js'), ctx);
    assert.equal(listeners.length, 1);
    listeners[0]({ data: { type: 'other' } });
    assert.deepEqual(assigned, []);
    listeners[0]({ data: { type: 'logout' } });
    assert.deepEqual(assigned, ['https://v.example/']);
  });

  it('creating a Subsonic API key for an unknown user answers 404', () => {
    const src = read('src/api/admin.js');
    const route = src.slice(src.indexOf('velvet.post("/api/v1/admin/users/subsonic-apikeys"'));
    assert.match(route.slice(0, 400), /Object\.hasOwn\(config\.program\.users \|\| \{\}, targetUser\)\) return res\.status\(404\)/);
  });
});

export const CREDENTIALS = {
  UPSTASH_REDIS_REST_URL: "https://fake.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "fake-token",
};
export const quiet = { error() {}, warn() {}, info() {} };

/**
 * Stands in for Upstash's REST endpoint.
 *
 * It holds the keys in one object and runs the handful of commands this store sends,
 * including the Lua increment — which is the only way to test the property that
 * matters: that two stores built from the same credentials, standing in for two warm
 * serverless instances, count against one counter rather than one each.
 */
export function fakeUpstash() {
  const keys = new Map();
  const calls = [];
  let fail = null;

  // Redis semantics, not convenient ones: a key with no expiry reports PTTL -1, an
  // absent one reports -2, and DECR on a missing key creates it at -1. Modelling the
  // inconvenient parts is the only way these tests can catch the bugs that live there.
  const pttl = (key) => {
    const entry = keys.get(key);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    if (entry.expiresAt <= Date.now()) {
      keys.delete(key);
      return -2;
    }
    return entry.expiresAt - Date.now();
  };

  const run = ([command, ...args]) => {
    if (command === "EVAL") {
      const [script, , key, windowMs] = args;

      // The health probe: SET with an expiry, then GET it back.
      if (script.includes('"SET"')) {
        const [, , , value, seconds] = args;
        keys.set(key, { value, expiresAt: Date.now() + Number(seconds) * 1000 });
        return value;
      }

      if (script.includes("INCR")) {
        pttl(key); // expire first, as Redis would before the INCR lands
        const entry = keys.get(key) ?? { hits: 0, expiresAt: null };
        entry.hits += 1;
        keys.set(key, entry);
        // Follows the script it was handed rather than the behaviour we want: a fake
        // that always repairs the TTL would let a store that never repairs it pass.
        const repairs = script.includes("ttl < 0");
        let ttl = pttl(key);
        if (entry.hits === 1 || (repairs && ttl < 0)) {
          entry.expiresAt = Date.now() + Number(windowMs);
          ttl = Number(windowMs);
        }
        return [entry.hits, ttl];
      }

      if (script.includes("EXISTS")) {
        if (pttl(key) === -2) return 0; // absent: the key must not be created
        const entry = keys.get(key);
        entry.hits -= 1;
        return entry.hits;
      }
      throw new Error("fake upstash got an unrecognised script");
    }
    if (command === "PING") return "PONG";
    if (command === "SET") {
      const [key, value, , seconds] = args;
      keys.set(key, { value, expiresAt: Date.now() + Number(seconds) * 1000 });
      return "OK";
    }
    if (command === "DEL") return keys.delete(args[0]) ? 1 : 0;
    throw new Error(`fake upstash got an unexpected command: ${command}`);
  };

  const fetchImpl = async (url, init) => {
    const args = JSON.parse(init.body);
    calls.push({ url, authorization: init.headers.Authorization, args });
    if (fail) return fail;
    return { ok: true, status: 200, json: async () => ({ result: run(args) }) };
  };

  return {
    fetchImpl,
    calls,
    keys,
    /** Strips a key's expiry, as a half-applied write or a bare DECR would leave it. */
    stripExpiry(suffix) {
      for (const [k, entry] of keys) if (k.endsWith(suffix)) entry.expiresAt = null;
    },
    /** Makes every later call answer like an unreachable or angry Upstash. */
    breakWith(response) {
      fail = response;
    },
  };
}

import assert from 'node:assert/strict';

// Check every delivered byte against the generated fixture, before acknowledging it.
export function createCaptureFixtureReceiver(expected, initialization, combinedInitialization = false) {
  let offset = 0, sequence = 0;
  const records = [];
  return {
    append(metadata, bytes) {
      assert.equal(metadata.track, 0, 'Unexpected capture track');
      assert.equal(metadata.generation, 0, 'Unexpected capture generation');
      assert.equal(metadata.sequence, sequence, 'Capture sequence gap or replay');
      assert.match(metadata.mime, /^video\/mp4(?:;|$)/);
      assert.ok(bytes.length > 0 && bytes.length <= 192 * 1024, 'Invalid capture chunk length');
      assert.ok(offset + bytes.length <= expected.length, 'Unexpected capture bytes');
      if (!sequence) assert.deepEqual(combinedInitialization ? bytes.subarray(0, initialization.length) : bytes, initialization, 'Initialization must be delivered before media');
      assert.deepEqual(bytes, expected.subarray(offset, offset + bytes.length), 'Capture byte mismatch');
      offset += bytes.length;
      records.push({ track: metadata.track, generation: metadata.generation, sequence, bytes: bytes.length });
      sequence++;
      return { track: metadata.track, sequence: metadata.sequence, bytes: offset };
    },
    finish() {
      assert.equal(offset, expected.length, 'Capture stopped before all expected bytes');
      assert.ok(sequence >= (combinedInitialization ? 1 : 2), 'Expected initialization and media chunks');
      return { bytes: offset, chunks: sequence, initializationFirst: true, records };
    },
  };
}

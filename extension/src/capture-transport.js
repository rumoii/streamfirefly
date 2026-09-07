export function createCaptureTransport(api) {
  const sessions = new Map();
  async function open(payload) {
    if (sessions.size >= 2 || !/^ws:\/\/127\.0\.0\.1:\d+$/.test(payload.endpoint) || !/^[a-f0-9]{64}$/.test(payload.token)) throw new Error("capture_transport_invalid");
    if (sessions.has(payload.id)) throw new Error("capture_already_open");
    const socket = new WebSocket(payload.endpoint);
    const session = { socket, tabId: payload.tabId, documentId: payload.documentId, pending: null, timer: null, heartbeat: null };
    sessions.set(payload.id, session);
    let rejectOpening;
    function dispose(error) { rejectOpening?.(error); rejectOpening = null; clearTimeout(session.timer); clearInterval(session.heartbeat); session.pending?.reject(error); session.pending = null; sessions.delete(payload.id); socket.close(); }
    await new Promise((resolve, reject) => {
      rejectOpening = reject;
      session.timer = setTimeout(() => { reject(new Error("capture_connect_timeout")); dispose(new Error("capture_connect_timeout")); }, 10000);
      socket.onopen = () => socket.send(JSON.stringify({ token: payload.token }));
      socket.onerror = () => { reject(new Error("capture_connection_failed")); dispose(new Error("capture_connection_failed")); };
      socket.onclose = () => { reject(new Error("capture_disconnected")); dispose(new Error("capture_disconnected")); };
      socket.onmessage = event => {
        let message; try { message = JSON.parse(event.data); } catch { dispose(new Error("capture_reply_invalid")); return; }
        if (message.ready) { rejectOpening = null; clearTimeout(session.timer); session.heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send("ping"); }, 10000); resolve(); }
        else if (message.sequence != null) { const pending = session.pending; if (!pending || pending.track !== message.track || pending.sequence !== message.sequence) { dispose(new Error("capture_ack_invalid")); return; } clearTimeout(session.timer); session.pending = null; pending.resolve(message); }
      };
    });
    return { ready: true };
  }
  async function push(payload, sender) {
    const session = sessions.get(payload.id);
    if (!session || sender.tab?.id !== session.tabId || sender.frameId !== 0 || session.documentId && sender.documentId !== session.documentId) throw new Error("capture_sender_invalid");
    if (session.pending) throw new Error("capture_backpressure");
    if (!Number.isInteger(payload.generation) || payload.generation < 0 || payload.generation >= 32) throw new Error("capture_generation_invalid");
    if (typeof payload.data !== "string" || payload.data.length > 350000 || !Number.isSafeInteger(payload.sequence) || payload.sequence < 0 || !Number.isInteger(payload.track) || payload.track < 0 || payload.track >= 32 || typeof payload.mime !== "string" || payload.mime.length > 200) throw new Error("capture_frame_invalid");
    const bytes = Uint8Array.from(atob(payload.data), char => char.charCodeAt(0));
    if (!bytes.length || bytes.length > 256 * 1024) throw new Error("capture_chunk_too_large");
    const metadata = new TextEncoder().encode(JSON.stringify({ sequence: payload.sequence, track: payload.track, generation: payload.generation, mime: payload.mime }));
    const frame = new Uint8Array(4 + metadata.length + bytes.length);
    new DataView(frame.buffer).setUint32(0, metadata.length, true); frame.set(metadata, 4); frame.set(bytes, metadata.length + 4);
    return new Promise((resolve, reject) => { session.pending = { track: payload.track, sequence: payload.sequence, resolve, reject }; session.timer = setTimeout(() => { session.pending = null; reject(new Error("capture_ack_timeout")); session.socket.close(); }, 30000); try { session.socket.send(frame); } catch { clearTimeout(session.timer); session.pending = null; reject(new Error("capture_disconnected")); } });
  }
  function close(id) { const session = sessions.get(id); if (!session) return; if (session.pending) throw new Error("capture_backpressure"); session.socket.send("finish"); clearInterval(session.heartbeat); sessions.delete(id); session.socket.close(); }
  function abort(id) { const session = sessions.get(id); if (!session) return; clearTimeout(session.timer); clearInterval(session.heartbeat); session.pending?.reject(new Error("capture_interrupted")); session.pending = null; sessions.delete(id); session.socket.close(); }
  return { open, push, close, abort };
}

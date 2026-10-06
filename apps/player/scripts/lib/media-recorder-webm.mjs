// Records a short canvas animation with MediaRecorder in the page that `client` drives, using a
// timeslice like the extension's tab recorder, and returns the chunks. Concatenated, they are the
// same kind of live WebM the extension stores: unknown sizes, no Duration, no Cues.

// A key frame every second starts a new cluster, as in a long tab recording.
const DEFAULTS = {
  durationMs: 3_000,
  timesliceMs: 500,
  width: 160,
  height: 90,
  frameRate: 30,
  keyFrameIntervalMs: 1_000
};

/**
 * @param {{ evaluate(expression: string): Promise<unknown> }} client
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {Promise<{ mime: string, chunks: Uint8Array[], durationMs: number }>}
 */
export async function recordCanvasWebm(client, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const result = await client.evaluate(`(async (settings) => {
    const canvas = Object.assign(document.createElement("canvas"), {
      width: settings.width,
      height: settings.height
    });
    const context = canvas.getContext("2d");
    const stream = canvas.captureStream(settings.frameRate);
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : "video/webm";
    const recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoKeyFrameIntervalDuration: settings.keyFrameIntervalMs
    });
    const chunks = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    const started = performance.now();
    let frame = 0;
    const draw = () => {
      frame += 1;
      context.fillStyle = "hsl(" + ((frame * 7) % 360) + " 70% 50%)";
      context.fillRect(0, 0, settings.width, settings.height);
      context.fillStyle = "#fff";
      context.fillRect((frame * 3) % settings.width, settings.height / 3, 12, 12);
    };
    draw();
    const timer = setInterval(draw, 1000 / settings.frameRate);
    const stopped = new Promise((resolve) => recorder.addEventListener("stop", resolve, { once: true }));
    recorder.start(settings.timesliceMs);
    await new Promise((resolve) => setTimeout(resolve, settings.durationMs));
    recorder.stop();
    await stopped;
    clearInterval(timer);
    stream.getTracks().forEach((track) => track.stop());
    const encoded = [];
    for (const chunk of chunks) {
      const bytes = new Uint8Array(await chunk.arrayBuffer());
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      encoded.push(btoa(binary));
    }
    return { mime, chunks: encoded, durationMs: Math.round(performance.now() - started) };
  })(${JSON.stringify(settings)})`);

  if (!result || !Array.isArray(result.chunks) || result.chunks.length === 0) {
    throw new Error("MediaRecorder produced no chunks");
  }

  return {
    mime: result.mime,
    durationMs: result.durationMs,
    chunks: result.chunks.map((chunk) => new Uint8Array(Buffer.from(chunk, "base64")))
  };
}

// Spike (task 56): rrweb's recorder as its own lazily imported module, loaded only by builds
// made with `WB_SPIKE_RRWEB=1`, so content-agent.js keeps its size budget.
export { createRrwebDomRecorder } from "webblackbox/rrweb-recorder";

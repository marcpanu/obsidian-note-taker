import { requestUrl } from "obsidian";
import { EagleProfiler, Eagle } from "@picovoice/eagle-web";
import type { EagleProfile } from "@picovoice/eagle-web";

const EAGLE_MODEL_URL =
	"https://raw.githubusercontent.com/Picovoice/eagle/main/lib/common/eagle_params.pv";

const EAGLE_SAMPLE_RATE = 16000;

export { EAGLE_SAMPLE_RATE };

export interface SpeakerScore {
	timestampMs: number;
	scores: number[];
}

/**
 * Manages Picovoice Eagle speaker enrollment and recognition.
 */
export class EagleSpeakerManager {
	private accessKey: string;
	private modelBase64: string | null = null;
	private profiler: EagleProfiler | null = null;
	private eagle: Eagle | null = null;

	constructor(accessKey: string) {
		this.accessKey = accessKey;
	}

	/** Download the Eagle model (cached in memory for the session). */
	private async ensureModel(): Promise<{ base64: string }> {
		if (this.modelBase64) return { base64: this.modelBase64 };

		console.log("Eagle: downloading model…");
		const response = await requestUrl({ url: EAGLE_MODEL_URL });
		this.modelBase64 = arrayBufferToBase64(response.arrayBuffer);
		console.log("Eagle: model loaded,", (this.modelBase64.length / 1024 / 1024).toFixed(1), "MB");

		return { base64: this.modelBase64 };
	}

	// -- Enrollment -----------------------------------------------------------

	async startEnrollment(): Promise<void> {
		const model = await this.ensureModel();
		this.profiler = await EagleProfiler.create(this.accessKey, model);
	}

	get minEnrollSamples(): number {
		return this.profiler?.minEnrollSamples ?? 0;
	}

	async enrollAudio(pcm: Int16Array): Promise<{ percentage: number; feedback: number }> {
		if (!this.profiler) throw new Error("Enrollment not started");
		const result = await this.profiler.enroll(pcm);
		return { percentage: result.percentage, feedback: result.feedback };
	}

	async exportProfile(): Promise<string> {
		if (!this.profiler) throw new Error("Enrollment not started");
		const profile = await this.profiler.export();
		await this.profiler.release();
		this.profiler = null;
		return uint8ArrayToBase64(profile.bytes);
	}

	async cancelEnrollment(): Promise<void> {
		if (this.profiler) {
			await this.profiler.release();
			this.profiler = null;
		}
	}

	/**
	 * Enroll a speaker from meeting audio segments.
	 * Takes the full PCM recording and a list of time ranges (ms) for one speaker.
	 * Returns the base64 profile, or null if not enough audio.
	 */
	async enrollFromSegments(
		fullPcm: Int16Array,
		segments: { startMs: number; endMs: number }[],
	): Promise<string | null> {
		await this.startEnrollment();
		const minSamples = this.minEnrollSamples;

		// Extract and concatenate audio for all segments
		const speakerSamples: Int16Array[] = [];
		for (const seg of segments) {
			const startSample = Math.floor((seg.startMs / 1000) * EAGLE_SAMPLE_RATE);
			const endSample = Math.min(
				Math.ceil((seg.endMs / 1000) * EAGLE_SAMPLE_RATE),
				fullPcm.length,
			);
			if (endSample > startSample) {
				speakerSamples.push(fullPcm.slice(startSample, endSample));
			}
		}

		if (speakerSamples.length === 0) {
			await this.cancelEnrollment();
			return null;
		}

		// Feed chunks to the profiler
		let percentage = 0;
		for (const chunk of speakerSamples) {
			// Feed in minSamples-sized pieces
			for (let offset = 0; offset + minSamples <= chunk.length; offset += minSamples) {
				const piece = chunk.slice(offset, offset + minSamples);
				const result = await this.enrollAudio(piece);
				percentage = result.percentage;
				if (percentage >= 100) break;
			}
			if (percentage >= 100) break;
		}

		if (percentage >= 100) {
			return await this.exportProfile();
		} else {
			console.log(`Eagle: enrollment only reached ${percentage.toFixed(0)}% — not enough audio`);
			await this.cancelEnrollment();
			return null;
		}
	}

	// -- Recognition ----------------------------------------------------------

	async startRecognition(profilesBase64: string[]): Promise<void> {
		const model = await this.ensureModel();
		const profiles: EagleProfile[] = profilesBase64.map((b64) => ({
			bytes: base64ToUint8Array(b64),
		}));
		this.eagle = await Eagle.create(this.accessKey, model, profiles);
	}

	get frameLength(): number {
		return this.eagle?.frameLength ?? 512;
	}

	async processFrame(pcm: Int16Array): Promise<number[]> {
		if (!this.eagle) throw new Error("Recognition not started");
		return await this.eagle.process(pcm);
	}

	async stopRecognition(): Promise<void> {
		if (this.eagle) {
			await this.eagle.release();
			this.eagle = null;
		}
	}
}

// -- Speaker mapping ----------------------------------------------------------

/**
 * Given AssemblyAI utterances (with timestamps) and Eagle per-frame scores,
 * map AssemblyAI speaker labels (A, B, C…) to enrolled profile names.
 */
export function mapSpeakersToProfiles(
	utterances: { speaker: string; start: number; end: number }[],
	eagleScores: SpeakerScore[],
	profileNames: string[],
	threshold = 0.3,
): Map<string, string> {
	// Accumulate Eagle scores per AssemblyAI speaker label
	const labelTotalScores = new Map<string, { scores: number[]; count: number }>();

	for (const utt of utterances) {
		// Find Eagle frames within this utterance's time range
		const relevant = eagleScores.filter(
			(s) => s.timestampMs >= utt.start && s.timestampMs <= utt.end,
		);
		if (relevant.length === 0) continue;

		if (!labelTotalScores.has(utt.speaker)) {
			labelTotalScores.set(utt.speaker, {
				scores: new Array(profileNames.length).fill(0),
				count: 0,
			});
		}
		const acc = labelTotalScores.get(utt.speaker)!;
		for (const rs of relevant) {
			for (let i = 0; i < rs.scores.length; i++) {
				acc.scores[i] += rs.scores[i];
			}
			acc.count += 1;
		}
	}

	// For each label, pick the profile with highest average score
	const labelToName = new Map<string, string>();
	const usedProfiles = new Set<number>();

	// Sort labels by total score (descending) so the best matches are assigned first
	const sortedLabels = [...labelTotalScores.entries()].sort((a, b) => {
		const maxA = Math.max(...a[1].scores);
		const maxB = Math.max(...b[1].scores);
		return maxB - maxA;
	});

	for (const [label, acc] of sortedLabels) {
		const avgScores = acc.scores.map((s) => s / acc.count);
		let bestIdx = -1;
		let bestScore = threshold;

		for (let i = 0; i < avgScores.length; i++) {
			if (avgScores[i] > bestScore && !usedProfiles.has(i)) {
				bestScore = avgScores[i];
				bestIdx = i;
			}
		}

		if (bestIdx >= 0) {
			labelToName.set(label, profileNames[bestIdx]);
			usedProfiles.add(bestIdx);
		}
	}

	return labelToName;
}

// -- AudioWorklet-based PCM capture -------------------------------------------

const WORKLET_CODE = `
class PCMCaptureProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.buffer = new Float32Array(4096);
		this.writeIndex = 0;
	}
	process(inputs) {
		const channel = inputs[0]?.[0];
		if (!channel) return true;
		for (let i = 0; i < channel.length; i++) {
			this.buffer[this.writeIndex++] = channel[i];
			if (this.writeIndex >= this.buffer.length) {
				this.port.postMessage(this.buffer.slice());
				this.writeIndex = 0;
			}
		}
		return true;
	}
}
registerProcessor('pcm-capture-processor', PCMCaptureProcessor);
`;

/**
 * Captures raw PCM audio from a MediaStream using AudioWorkletNode.
 * Calls onChunk with Float32Array buffers at the AudioContext's native sample rate.
 */
export class AudioPcmCapture {
	private audioContext: AudioContext | null = null;
	private workletNode: AudioWorkletNode | null = null;
	private source: MediaStreamAudioSourceNode | null = null;

	/** Start capturing. Returns the native sample rate. */
	async start(stream: MediaStream, onChunk: (pcm: Float32Array) => void): Promise<number> {
		this.audioContext = new AudioContext();

		const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
		const url = URL.createObjectURL(blob);
		await this.audioContext.audioWorklet.addModule(url);
		URL.revokeObjectURL(url);

		this.source = this.audioContext.createMediaStreamSource(stream);
		this.workletNode = new AudioWorkletNode(this.audioContext, "pcm-capture-processor");
		this.workletNode.port.onmessage = (e: MessageEvent) => {
			onChunk(e.data as Float32Array);
		};
		this.source.connect(this.workletNode);

		return this.audioContext.sampleRate;
	}

	stop() {
		if (this.workletNode) {
			this.workletNode.disconnect();
			this.workletNode = null;
		}
		if (this.source) {
			this.source.disconnect();
			this.source = null;
		}
		if (this.audioContext) {
			this.audioContext.close().catch(() => {});
			this.audioContext = null;
		}
	}
}

// -- Audio helpers ------------------------------------------------------------

/** Downsample Float32 audio from one sample rate to another. */
export function downsamplePcm(
	input: Float32Array,
	fromRate: number,
	toRate: number,
): Float32Array {
	if (fromRate === toRate) return input;
	const ratio = fromRate / toRate;
	const length = Math.round(input.length / ratio);
	const result = new Float32Array(length);
	for (let i = 0; i < length; i++) {
		result[i] = input[Math.round(i * ratio)];
	}
	return result;
}

/** Convert Float32 [-1,1] audio to Int16 PCM. */
export function float32ToInt16(input: Float32Array): Int16Array {
	const output = new Int16Array(input.length);
	for (let i = 0; i < input.length; i++) {
		const s = Math.max(-1, Math.min(1, input[i]));
		output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
	}
	return output;
}

// -- Binary helpers -----------------------------------------------------------

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const chunks: string[] = [];
	const chunkSize = 8192;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		chunks.push(String.fromCharCode(...chunk));
	}
	return btoa(chunks.join(""));
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
	const chunks: string[] = [];
	const chunkSize = 8192;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		chunks.push(String.fromCharCode(...chunk));
	}
	return btoa(chunks.join(""));
}

function base64ToUint8Array(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

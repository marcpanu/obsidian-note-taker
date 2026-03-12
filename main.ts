import { Plugin, PluginSettingTab, Setting, Notice, Editor, Modal, requestUrl } from "obsidian";
import {
	EagleSpeakerManager,
	AudioPcmCapture,
	SpeakerScore,
	EAGLE_SAMPLE_RATE,
	mapSpeakersToProfiles,
	downsamplePcm,
	float32ToInt16,
} from "./eagle-speaker";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AINotetakerSettings {
	assemblyAiApiKey: string;
	picovoiceAccessKey: string;
	speakerProfiles: Record<string, string>; // name → base64-encoded EagleProfile
}

const DEFAULT_SETTINGS: AINotetakerSettings = {
	assemblyAiApiKey: "",
	picovoiceAccessKey: "",
	speakerProfiles: {},
};

interface AssemblyAIUtterance {
	speaker: string;
	text: string;
	start: number;
	end: number;
}

interface AssemblyAIHighlight {
	text: string;
	count: number;
	rank: number;
}

interface AssemblyAITranscriptResponse {
	id: string;
	status: "queued" | "processing" | "completed" | "error";
	error?: string;
	summary?: string;
	utterances?: AssemblyAIUtterance[];
	auto_highlights_result?: { results: AssemblyAIHighlight[] };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default class AINotetakerPlugin extends Plugin {
	settings: AINotetakerSettings = DEFAULT_SETTINGS;
	private statusBarItem: HTMLElement | null = null;
	private mediaRecorder: MediaRecorder | null = null;
	private audioChunks: Blob[] = [];
	private isRecording = false;

	// Eagle state during recording
	private eagleManager: EagleSpeakerManager | null = null;
	private eagleScores: SpeakerScore[] = [];
	private eagleProfileNames: string[] = [];
	private pcmCapture: AudioPcmCapture | null = null;
	private pcmBuffer: Int16Array = new Int16Array(0);
	private fullPcmRecording: Int16Array = new Int16Array(0);
	private recordingStartTime = 0;

	// Last recording data for deferred labeling via "Label Speakers"
	private lastUtterances: AssemblyAIUtterance[] | null = null;
	private lastFullPcm: Int16Array | null = null;
	private lastEagleScores: SpeakerScore[] | null = null;
	private lastEagleProfileNames: string[] | null = null;

	async onload() {
		await this.loadSettings();

		this.statusBarItem = this.addStatusBarItem();

		this.addCommand({
			id: "start-stop-recording",
			name: "Start / Stop Recording",
			editorCallback: (editor: Editor) => {
				if (this.isRecording) {
					this.stopRecording(editor);
				} else {
					this.startRecording();
				}
			},
		});

		this.addCommand({
			id: "label-speakers",
			name: "Label Speakers",
			editorCallback: (editor: Editor) => {
				this.labelSpeakersInNote(editor);
			},
		});

		this.addCommand({
			id: "enroll-speaker",
			name: "Enroll Speaker Voice Profile",
			callback: () => {
				new EnrollSpeakerModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: "manage-speakers",
			name: "Manage Speaker Profiles",
			callback: () => {
				new ManageSpeakersModal(this.app, this).open();
			},
		});

		this.addSettingTab(new AINotetakerSettingTab(this.app, this));
	}

	onunload() {
		if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
			this.mediaRecorder.stop();
		}
		this.cleanupEagleRecording();
		this.setStatusBar("");
	}

	// -- Settings helpers ----------------------------------------------------

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		if (!this.settings.speakerProfiles) {
			this.settings.speakerProfiles = {};
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// -- Status bar helpers --------------------------------------------------

	private setStatusBar(text: string) {
		if (this.statusBarItem) {
			this.statusBarItem.setText(text);
		}
	}

	// -- Recording -----------------------------------------------------------

	private async startRecording() {
		if (!this.settings.assemblyAiApiKey) {
			new Notice("AI Notetaker: Please set your AssemblyAI API key in settings.");
			return;
		}

		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch (err) {
			new Notice("AI Notetaker: Microphone access denied.");
			return;
		}

		this.audioChunks = [];

		const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
			? "audio/webm;codecs=opus"
			: "";

		this.mediaRecorder = mimeType
			? new MediaRecorder(stream, { mimeType })
			: new MediaRecorder(stream);

		this.mediaRecorder.ondataavailable = (event: BlobEvent) => {
			if (event.data.size > 0) {
				this.audioChunks.push(event.data);
			}
		};

		this.mediaRecorder.start(1000);
		this.isRecording = true;
		this.recordingStartTime = Date.now();
		this.setStatusBar("🔴 Recording…");
		new Notice("AI Notetaker: Recording started.");

		// Clear previous recording data
		this.lastUtterances = null;
		this.lastFullPcm = null;
		this.lastEagleScores = null;
		this.lastEagleProfileNames = null;

		await this.startAudioCapture(stream);
	}

	private async startAudioCapture(stream: MediaStream) {
		if (!this.settings.picovoiceAccessKey) {
			return;
		}

		try {
			// Start real-time recognition if profiles exist
			const profileNames = Object.keys(this.settings.speakerProfiles);
			if (profileNames.length > 0) {
				const profileData = profileNames.map((n) => this.settings.speakerProfiles[n]);
				this.eagleManager = new EagleSpeakerManager(this.settings.picovoiceAccessKey);
				await this.eagleManager.startRecognition(profileData);
				this.eagleProfileNames = profileNames;
				this.eagleScores = [];
				console.log("AI Notetaker: Eagle recognition started with", profileNames.length, "profiles");
			}

			this.fullPcmRecording = new Int16Array(0);
			this.pcmBuffer = new Int16Array(0);

			const startTime = this.recordingStartTime;

			this.pcmCapture = new AudioPcmCapture();
			const nativeSampleRate = await this.pcmCapture.start(stream, (float32Chunk) => {
				const resampled = downsamplePcm(float32Chunk, nativeSampleRate, EAGLE_SAMPLE_RATE);
				const int16 = float32ToInt16(resampled);

				// Append to full recording buffer
				const newFull = new Int16Array(this.fullPcmRecording.length + int16.length);
				newFull.set(this.fullPcmRecording);
				newFull.set(int16, this.fullPcmRecording.length);
				this.fullPcmRecording = newFull;

				// Feed to Eagle recognition if active
				if (this.eagleManager) {
					const newBuf = new Int16Array(this.pcmBuffer.length + int16.length);
					newBuf.set(this.pcmBuffer);
					newBuf.set(int16, this.pcmBuffer.length);
					this.pcmBuffer = newBuf;

					const frameLen = this.eagleManager.frameLength;
					while (this.pcmBuffer.length >= frameLen) {
						const frame = this.pcmBuffer.slice(0, frameLen);
						this.pcmBuffer = this.pcmBuffer.slice(frameLen);

						this.eagleManager.processFrame(frame).then((frameScores) => {
							this.eagleScores.push({
								timestampMs: Date.now() - startTime,
								scores: frameScores,
							});
						}).catch((err) => {
							console.error("Eagle processFrame error:", err);
						});
					}
				}
			});
		} catch (err) {
			console.error("AI Notetaker: Failed to start audio capture:", err);
			new Notice("AI Notetaker: Speaker recognition unavailable — recording without it.");
			this.cleanupEagleRecording();
		}
	}

	private cleanupEagleRecording() {
		if (this.pcmCapture) {
			this.pcmCapture.stop();
			this.pcmCapture = null;
		}
		if (this.eagleManager) {
			this.eagleManager.stopRecognition().catch(() => {});
			this.eagleManager = null;
		}
		this.pcmBuffer = new Int16Array(0);
	}

	private stopRecording(editor: Editor) {
		if (!this.mediaRecorder) return;

		const eagleScores = [...this.eagleScores];
		const eagleProfileNames = [...this.eagleProfileNames];
		const fullPcm = this.fullPcmRecording;

		this.mediaRecorder.onstop = async () => {
			this.mediaRecorder?.stream.getTracks().forEach((t) => t.stop());

			const audioBlob = new Blob(this.audioChunks, {
				type: this.mediaRecorder?.mimeType ?? "audio/webm",
			});
			this.audioChunks = [];
			this.isRecording = false;

			this.cleanupEagleRecording();

			await this.transcribeAndInsert(audioBlob, editor, eagleScores, eagleProfileNames, fullPcm);
		};

		this.mediaRecorder.stop();
		this.setStatusBar("⏳ Transcribing…");
		new Notice("AI Notetaker: Recording stopped. Transcribing…");
	}

	// -- AssemblyAI integration ----------------------------------------------

	private async transcribeAndInsert(
		audioBlob: Blob,
		editor: Editor,
		eagleScores: SpeakerScore[],
		eagleProfileNames: string[],
		fullPcm: Int16Array,
	) {
		const apiKey = this.settings.assemblyAiApiKey;

		try {
			const uploadUrl = await this.uploadAudio(audioBlob, apiKey);
			const transcriptId = await this.submitTranscription(uploadUrl, apiKey);
			const result = await this.pollTranscription(transcriptId, apiKey);

			// Auto-apply Eagle suggestions for known speakers
			let speakerMap: Map<string, string> | null = null;
			if (
				eagleScores.length > 0 &&
				eagleProfileNames.length > 0 &&
				result.utterances?.length
			) {
				speakerMap = mapSpeakersToProfiles(result.utterances, eagleScores, eagleProfileNames);
				console.log("AI Notetaker: Auto-mapped speakers:", Object.fromEntries(speakerMap));
			}

			// Insert markdown immediately (known speakers get names, unknowns get "Speaker X")
			const markdown = this.buildMarkdown(result, speakerMap);
			this.insertIntoEditor(editor, markdown);

			// Store data for deferred "Label Speakers" command
			this.lastUtterances = result.utterances ?? null;
			this.lastFullPcm = fullPcm.length > 0 ? fullPcm : null;
			this.lastEagleScores = eagleScores.length > 0 ? eagleScores : null;
			this.lastEagleProfileNames = eagleProfileNames.length > 0 ? eagleProfileNames : null;

			this.setStatusBar("");

			// Hint about labeling if there are unlabeled speakers
			const hasUnlabeled = result.utterances?.some(
				(u) => !speakerMap?.has(u.speaker),
			);
			if (hasUnlabeled && this.settings.picovoiceAccessKey) {
				new Notice(
					'AI Notetaker: Transcription complete! Use "Label Speakers" command to name speakers and enroll them.',
					8000,
				);
			} else {
				new Notice("AI Notetaker: Transcription complete!");
			}
		} catch (err: any) {
			console.error("AI Notetaker error:", err);
			const message = err instanceof Error ? err.message : String(err);
			const errorBlock = `\n> ⚠️ Transcription failed: ${message}\n`;
			this.insertIntoEditor(editor, errorBlock);
			this.setStatusBar("");
			new Notice(`AI Notetaker: Transcription failed — ${message}`);
		}
	}

	// -- Label Speakers (deferred) -------------------------------------------

	private async labelSpeakersInNote(editor: Editor) {
		if (!this.settings.picovoiceAccessKey) {
			new Notice("AI Notetaker: Set your Picovoice AccessKey in settings to use speaker labeling.");
			return;
		}

		const content = editor.getValue();

		// Find all "**Speaker X:**" patterns in the note
		const speakerPattern = /\*\*Speaker ([A-Z]):\*\*/g;
		const labels = new Set<string>();
		let match;
		while ((match = speakerPattern.exec(content)) !== null) {
			labels.add(match[1]);
		}

		if (labels.size === 0) {
			new Notice("AI Notetaker: No speaker labels found in this note.");
			return;
		}

		const speakerLabels = [...labels].sort();

		// Build preview text for each speaker from the note content
		const previewUtterances: AssemblyAIUtterance[] = [];
		for (const label of speakerLabels) {
			const linePattern = new RegExp(`\\*\\*Speaker ${label}:\\*\\*\\s*(.+)`, "g");
			const lineMatch = linePattern.exec(content);
			if (lineMatch) {
				previewUtterances.push({
					speaker: label,
					text: lineMatch[1],
					start: 0,
					end: 0,
				});
			}
		}

		// Build suggestions from stored Eagle data if available
		let suggestions: Map<string, string> | null = null;
		if (
			this.lastEagleScores?.length &&
			this.lastEagleProfileNames?.length &&
			this.lastUtterances?.length
		) {
			suggestions = mapSpeakersToProfiles(
				this.lastUtterances,
				this.lastEagleScores,
				this.lastEagleProfileNames,
			);
		}

		const speakerMap = await new Promise<Map<string, string> | null>((resolve) => {
			const modal = new SpeakerMappingModal(
				this.app,
				this,
				speakerLabels,
				previewUtterances.length > 0 ? previewUtterances : null,
				suggestions,
				resolve,
			);
			modal.open();
		});

		if (!speakerMap || speakerMap.size === 0) return;

		// Replace "**Speaker X:**" with "**Name:**" in the editor
		let newContent = editor.getValue();
		for (const [label, name] of speakerMap) {
			const pattern = new RegExp(`\\*\\*Speaker ${label}:\\*\\*`, "g");
			newContent = newContent.replace(pattern, `**${name}:**`);
		}
		editor.setValue(newContent);

		// Enroll new speakers from meeting audio if available
		if (this.lastFullPcm && this.lastUtterances) {
			await this.enrollNewSpeakersFromMeeting(
				speakerMap,
				this.lastUtterances,
				this.lastFullPcm,
			);
		}

		new Notice("AI Notetaker: Speaker labels updated!");
	}

	// -- Enrollment from meeting audio ---------------------------------------

	private async enrollNewSpeakersFromMeeting(
		speakerMap: Map<string, string>,
		utterances: AssemblyAIUtterance[],
		fullPcm: Int16Array,
	) {
		const existingNames = new Set(Object.keys(this.settings.speakerProfiles));

		for (const [label, name] of speakerMap) {
			if (existingNames.has(name)) continue;

			const segments = utterances
				.filter((u) => u.speaker === label)
				.map((u) => ({ startMs: u.start, endMs: u.end }));

			if (segments.length === 0) continue;

			try {
				new Notice(`AI Notetaker: Enrolling "${name}" from meeting audio…`);
				const mgr = new EagleSpeakerManager(this.settings.picovoiceAccessKey);
				const profileBase64 = await mgr.enrollFromSegments(fullPcm, segments);

				if (profileBase64) {
					this.settings.speakerProfiles[name] = profileBase64;
					await this.saveSettings();
					new Notice(`AI Notetaker: "${name}" enrolled successfully!`);
				} else {
					new Notice(`AI Notetaker: Not enough audio to enroll "${name}" — try a longer meeting.`);
				}
			} catch (err) {
				console.error(`AI Notetaker: Failed to enroll "${name}":`, err);
				new Notice(`AI Notetaker: Failed to enroll "${name}".`);
			}
		}
	}

	// -- AssemblyAI API calls ------------------------------------------------

	private async uploadAudio(blob: Blob, apiKey: string): Promise<string> {
		const arrayBuffer = await blob.arrayBuffer();
		console.log("AI Notetaker: uploading audio, size:", arrayBuffer.byteLength);
		const response = await requestUrl({
			url: "https://api.assemblyai.com/v2/upload",
			method: "POST",
			headers: {
				authorization: apiKey,
				"Content-Type": "application/octet-stream",
			},
			body: arrayBuffer,
		});
		return response.json.upload_url;
	}

	private async submitTranscription(audioUrl: string, apiKey: string): Promise<string> {
		const response = await requestUrl({
			url: "https://api.assemblyai.com/v2/transcript",
			method: "POST",
			headers: {
				authorization: apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				audio_url: audioUrl,
				speech_models: ["universal-3-pro"],
				speaker_labels: true,
				summarization: true,
				summary_model: "informative",
				summary_type: "bullets",
				auto_highlights: true,
			}),
		});
		return response.json.id;
	}

	private async pollTranscription(
		transcriptId: string,
		apiKey: string,
	): Promise<AssemblyAITranscriptResponse> {
		const url = `https://api.assemblyai.com/v2/transcript/${transcriptId}`;

		while (true) {
			const response = await requestUrl({
				url,
				headers: { authorization: apiKey },
			});

			if (response.status >= 400) {
				throw new Error(`Polling failed (HTTP ${response.status})`);
			}

			const data: AssemblyAITranscriptResponse = response.json;

			if (data.status === "completed") return data;
			if (data.status === "error") throw new Error(data.error ?? "Unknown transcription error");

			await this.sleep(3000);
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	// -- Markdown builder ----------------------------------------------------

	private buildMarkdown(
		result: AssemblyAITranscriptResponse,
		speakerMap: Map<string, string> | null,
	): string {
		const now = new Date();
		const date = now.toISOString().slice(0, 10);
		const time = now.toTimeString().slice(0, 5);

		const lines: string[] = [
			"",
			"---",
			"## 🎙️ Meeting Notes",
			`**Date:** ${date} ${time}`,
			"",
			"### Summary",
		];

		if (result.summary) {
			const bullets = result.summary
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l.length > 0);
			for (const bullet of bullets) {
				lines.push(bullet.startsWith("-") ? bullet : `- ${bullet}`);
			}
		} else {
			lines.push("- No summary available");
		}

		lines.push("");
		lines.push("### Action Items");

		const highlights = result.auto_highlights_result?.results;
		if (highlights && highlights.length > 0) {
			for (const h of highlights) {
				lines.push(`- ${h.text}`);
			}
		} else {
			lines.push("- No action items detected");
		}

		lines.push("");
		lines.push("### Transcript");

		if (result.utterances && result.utterances.length > 0) {
			for (const u of result.utterances) {
				const name = speakerMap?.get(u.speaker) ?? `Speaker ${u.speaker}`;
				lines.push(`**${name}:** ${u.text}`);
				lines.push("");
			}
		} else {
			lines.push("No transcript available.");
			lines.push("");
		}

		lines.push("---");
		lines.push("");

		return lines.join("\n");
	}

	private insertIntoEditor(editor: Editor, text: string) {
		const cursor = editor.getCursor();
		editor.replaceRange(text, cursor);
	}
}

// ---------------------------------------------------------------------------
// Speaker Mapping Modal
// ---------------------------------------------------------------------------

class SpeakerMappingModal extends Modal {
	private plugin: AINotetakerPlugin;
	private speakerLabels: string[];
	private utterances: AssemblyAIUtterance[] | null;
	private suggestions: Map<string, string> | null;
	private resolve: (result: Map<string, string> | null) => void;
	private resolved = false;
	private nameInputs: Map<string, HTMLInputElement> = new Map();

	constructor(
		app: any,
		plugin: AINotetakerPlugin,
		speakerLabels: string[],
		utterances: AssemblyAIUtterance[] | null,
		suggestions: Map<string, string> | null,
		resolve: (result: Map<string, string> | null) => void,
	) {
		super(app);
		this.plugin = plugin;
		this.speakerLabels = speakerLabels;
		this.utterances = utterances;
		this.suggestions = suggestions;
		this.resolve = resolve;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Identify Speakers" });
		contentEl.createEl("p", {
			text: "Name each speaker. New names will be enrolled for future recognition.",
			cls: "setting-item-description",
		});

		const existingNames = Object.keys(this.plugin.settings.speakerProfiles);

		for (const label of this.speakerLabels) {
			// Find a sample utterance for this speaker
			const sample = this.utterances?.find((u) => u.speaker === label);
			const preview = sample
				? sample.text.length > 80
					? sample.text.slice(0, 80) + "…"
					: sample.text
				: "";

			const row = contentEl.createEl("div");
			row.style.cssText = "margin-bottom:16px;";

			const labelEl = row.createEl("div");
			labelEl.style.cssText = "font-weight:600;margin-bottom:4px;";
			labelEl.setText(`Speaker ${label}`);

			if (preview) {
				const previewEl = row.createEl("div");
				previewEl.style.cssText =
					"font-size:0.85em;color:var(--text-muted);margin-bottom:6px;font-style:italic;";
				previewEl.setText(`"${preview}"`);
			}

			const input = row.createEl("input", { type: "text" });
			input.style.cssText = "width:100%;";
			input.placeholder = "Enter name (e.g. Alice)";

			const suggestion = this.suggestions?.get(label);
			if (suggestion) {
				input.value = suggestion;
			}

			if (existingNames.length > 0) {
				const listId = `speaker-list-${label}`;
				const datalist = row.createEl("datalist");
				datalist.id = listId;
				for (const name of existingNames) {
					datalist.createEl("option", { value: name });
				}
				input.setAttribute("list", listId);
			}

			this.nameInputs.set(label, input);
		}

		const btnContainer = contentEl.createEl("div");
		btnContainer.style.cssText = "display:flex;gap:8px;margin-top:16px;justify-content:flex-end;";

		const skipBtn = btnContainer.createEl("button", { text: "Skip" });
		skipBtn.addEventListener("click", () => {
			this.resolved = true;
			this.resolve(null);
			this.close();
		});

		const applyBtn = btnContainer.createEl("button", { text: "Apply" });
		applyBtn.addClass("mod-cta");
		applyBtn.addEventListener("click", () => {
			const result = new Map<string, string>();
			for (const [label, input] of this.nameInputs) {
				const name = input.value.trim();
				if (name) {
					result.set(label, name);
				}
			}
			this.resolved = true;
			this.resolve(result);
			this.close();
		});
	}

	onClose() {
		if (!this.resolved) {
			this.resolve(null);
		}
		this.contentEl.empty();
	}
}

// ---------------------------------------------------------------------------
// Enroll Speaker Modal (standalone)
// ---------------------------------------------------------------------------

class EnrollSpeakerModal extends Modal {
	private plugin: AINotetakerPlugin;
	private eagleManager: EagleSpeakerManager | null = null;
	private stream: MediaStream | null = null;
	private pcmCapture: AudioPcmCapture | null = null;
	private pcmBuffer: Int16Array = new Int16Array(0);
	private isEnrolling = false;
	private speakerName = "";

	constructor(app: any, plugin: AINotetakerPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		if (!this.plugin.settings.picovoiceAccessKey) {
			contentEl.createEl("p", {
				text: "Please set your Picovoice AccessKey in AI Notetaker settings first.",
			});
			return;
		}

		contentEl.createEl("h2", { text: "Enroll Speaker" });
		contentEl.createEl("p", {
			text: 'Enter a name and record 10-15 seconds of the speaker talking. (Tip: speakers are also auto-enrolled when you name them via "Label Speakers" after a meeting.)',
		});

		new Setting(contentEl)
			.setName("Speaker Name")
			.addText((text) =>
				text.setPlaceholder("e.g. Alice").onChange((value) => {
					this.speakerName = value.trim();
				}),
			);

		const statusEl = contentEl.createEl("p", { text: "" });
		const progressEl = contentEl.createEl("div");
		progressEl.style.cssText =
			"width:100%;height:20px;background:#333;border-radius:4px;overflow:hidden;margin:10px 0;display:none;";
		const progressBar = progressEl.createEl("div");
		progressBar.style.cssText = "width:0%;height:100%;background:#5b8;transition:width 0.3s;";

		const btnContainer = contentEl.createEl("div");
		btnContainer.style.cssText = "display:flex;gap:8px;margin-top:12px;";

		const startBtn = btnContainer.createEl("button", { text: "Start Recording" });
		startBtn.addClass("mod-cta");

		const cancelBtn = btnContainer.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		startBtn.addEventListener("click", async () => {
			if (!this.speakerName) {
				new Notice("Please enter a speaker name.");
				return;
			}
			if (this.isEnrolling) return;

			startBtn.disabled = true;
			this.isEnrolling = true;
			statusEl.setText("Initializing Eagle…");
			progressEl.style.display = "block";

			try {
				this.eagleManager = new EagleSpeakerManager(this.plugin.settings.picovoiceAccessKey);
				await this.eagleManager.startEnrollment();

				this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
				this.pcmBuffer = new Int16Array(0);

				const minSamples = this.eagleManager.minEnrollSamples;
				const mgr = this.eagleManager;

				statusEl.setText("🔴 Recording… speak now!");

				this.pcmCapture = new AudioPcmCapture();
				const nativeSampleRate = await this.pcmCapture.start(this.stream, (float32Chunk) => {
					if (!this.isEnrolling) return;

					const resampled = downsamplePcm(float32Chunk, nativeSampleRate, EAGLE_SAMPLE_RATE);
					const int16 = float32ToInt16(resampled);

					const newBuf = new Int16Array(this.pcmBuffer.length + int16.length);
					newBuf.set(this.pcmBuffer);
					newBuf.set(int16, this.pcmBuffer.length);
					this.pcmBuffer = newBuf;

					if (this.pcmBuffer.length >= minSamples) {
						const chunk = this.pcmBuffer.slice(0, minSamples);
						this.pcmBuffer = this.pcmBuffer.slice(minSamples);

						mgr.enrollAudio(chunk)
							.then(async (result) => {
								progressBar.style.width = `${Math.min(result.percentage, 100)}%`;
								statusEl.setText(
									`🔴 Recording… ${Math.round(result.percentage)}% enrolled`,
								);

								if (result.percentage >= 100) {
									this.isEnrolling = false;
									statusEl.setText("Saving profile…");

									const profileBase64 = await mgr.exportProfile();
									this.plugin.settings.speakerProfiles[this.speakerName] = profileBase64;
									await this.plugin.saveSettings();

									this.cleanupRecording();
									statusEl.setText(`✅ "${this.speakerName}" enrolled successfully!`);
									progressBar.style.width = "100%";

									new Notice(`AI Notetaker: Speaker "${this.speakerName}" enrolled!`);
									setTimeout(() => this.close(), 1500);
								}
							})
							.catch((err) => {
								console.error("Eagle enrollment error:", err);
								statusEl.setText(`Error: ${err.message}`);
							});
					}
				});
			} catch (err: any) {
				console.error("Enrollment setup error:", err);
				statusEl.setText(`Error: ${err.message}`);
				this.isEnrolling = false;
				startBtn.disabled = false;
			}
		});
	}

	private cleanupRecording() {
		this.isEnrolling = false;
		if (this.pcmCapture) {
			this.pcmCapture.stop();
			this.pcmCapture = null;
		}
		if (this.stream) {
			this.stream.getTracks().forEach((t) => t.stop());
			this.stream = null;
		}
	}

	onClose() {
		this.cleanupRecording();
		if (this.eagleManager) {
			this.eagleManager.cancelEnrollment().catch(() => {});
			this.eagleManager = null;
		}
		this.contentEl.empty();
	}
}

// ---------------------------------------------------------------------------
// Manage Speakers Modal
// ---------------------------------------------------------------------------

class ManageSpeakersModal extends Modal {
	private plugin: AINotetakerPlugin;

	constructor(app: any, plugin: AINotetakerPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		this.renderContent();
	}

	private renderContent() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Speaker Profiles" });

		const profiles = this.plugin.settings.speakerProfiles;
		const names = Object.keys(profiles);

		if (names.length === 0) {
			contentEl.createEl("p", {
				text: 'No speaker profiles enrolled yet. Speakers are automatically enrolled when you name them via "Label Speakers" after a meeting.',
			});
			return;
		}

		for (const name of names) {
			new Setting(contentEl)
				.setName(name)
				.setDesc("Enrolled speaker profile")
				.addButton((btn) =>
					btn
						.setButtonText("Delete")
						.setWarning()
						.onClick(async () => {
							delete this.plugin.settings.speakerProfiles[name];
							await this.plugin.saveSettings();
							new Notice(`AI Notetaker: Deleted speaker "${name}".`);
							this.renderContent();
						}),
				);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

class AINotetakerSettingTab extends PluginSettingTab {
	plugin: AINotetakerPlugin;

	constructor(app: any, plugin: AINotetakerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "AI Notetaker Settings" });

		new Setting(containerEl)
			.setName("AssemblyAI API Key")
			.setDesc(
				createFragment((frag) => {
					frag.appendText("Enter your AssemblyAI API key. Get one at ");
					frag.createEl("a", {
						text: "assemblyai.com",
						href: "https://www.assemblyai.com",
					});
					frag.appendText(".");
				}),
			)
			.addText((text) =>
				text
					.setPlaceholder("your-api-key")
					.setValue(this.plugin.settings.assemblyAiApiKey)
					.onChange(async (value) => {
						this.plugin.settings.assemblyAiApiKey = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Picovoice AccessKey")
			.setDesc(
				createFragment((frag) => {
					frag.appendText("For speaker recognition. Free at ");
					frag.createEl("a", {
						text: "console.picovoice.ai",
						href: "https://console.picovoice.ai/",
					});
					frag.appendText(". Leave blank to disable speaker identification.");
				}),
			)
			.addText((text) =>
				text
					.setPlaceholder("your-picovoice-key")
					.setValue(this.plugin.settings.picovoiceAccessKey)
					.onChange(async (value) => {
						this.plugin.settings.picovoiceAccessKey = value;
						await this.plugin.saveSettings();
					}),
			);

		const profileCount = Object.keys(this.plugin.settings.speakerProfiles).length;
		new Setting(containerEl)
			.setName("Speaker Profiles")
			.setDesc(
				`${profileCount} speaker(s) enrolled. Use the "Manage Speaker Profiles" command to view or remove.`,
			);
	}
}

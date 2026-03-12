import {
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	Editor,
	Modal,
	requestUrl,
	MarkdownView,
	ItemView,
	WorkspaceLeaf,
	setIcon,
} from "obsidian";
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
	geminiApiKey: string;
	templateFolder: string;
	selectedTemplate: string;
	geminiModel: string;
	speakerProfiles: Record<string, string>; // name → base64-encoded EagleProfile
}

const DEFAULT_SETTINGS: AINotetakerSettings = {
	assemblyAiApiKey: "",
	picovoiceAccessKey: "",
	geminiApiKey: "",
	templateFolder: "AI Notetaker Templates",
	selectedTemplate: "Default",
	geminiModel: "gemini-2.5-flash",
	speakerProfiles: {},
};

const DEFAULT_TEMPLATE = `You are a meeting notes assistant. Given the following meeting transcript with speaker labels, produce structured meeting notes in markdown format.

## Output format:

Your response MUST begin with a single-line title for the meeting on the first line, prefixed with "# " (markdown H1). The title should be a concise, descriptive summary of the meeting topic (e.g., "# Q2 Marketing Strategy Review"). Do NOT include a date in the title.

### Attendees
List each speaker with their name. If their role or organization is mentioned in the conversation, include it.

### Summary
Provide a clear overall summary of the meeting. Use a mix of prose and bullet points as appropriate to capture key discussion points, decisions made, and important context.

### Action Items
List action items as a task list. Tag each with the owner.
- [ ] **Owner:** Description of the action item

## Transcript:
{{transcript}}`;

interface AssemblyAIUtterance {
	speaker: string;
	text: string;
	start: number;
	end: number;
}

interface AssemblyAITranscriptResponse {
	id: string;
	status: "queued" | "processing" | "completed" | "error";
	error?: string;
	utterances?: AssemblyAIUtterance[];
}

const SPEAKER_VIEW_TYPE = "ai-notetaker-speakers";

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default class AINotetakerPlugin extends Plugin {
	settings: AINotetakerSettings = DEFAULT_SETTINGS;
	private statusBarItem: HTMLElement | null = null;
	private ribbonIconEl: HTMLElement | null = null;
	private mediaRecorder: MediaRecorder | null = null;
	private audioChunks: Blob[] = [];
	isRecording = false;

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

		// Ribbon icon — toggles recording
		this.ribbonIconEl = this.addRibbonIcon("mic", "AI Notetaker: Record", () => {
			const editor = this.getMarkdownEditor();
			if (!editor) {
				new Notice("AI Notetaker: Open a note first.");
				return;
			}
			if (this.isRecording) {
				this.stopRecording(editor);
			} else {
				this.startRecording();
			}
		});

		// Sidebar view for speaker management
		this.registerView(SPEAKER_VIEW_TYPE, (leaf) => new SpeakerPanelView(leaf, this));

		this.addCommand({
			id: "open-speaker-panel",
			name: "Open Speaker Panel",
			callback: () => this.activateSpeakerPanel(),
		});
	}

	onunload() {
		if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
			this.mediaRecorder.stop();
		}
		this.cleanupEagleRecording();
		this.setStatusBar("");
		this.app.workspace.detachLeavesOfType(SPEAKER_VIEW_TYPE);
	}

	async activateSpeakerPanel() {
		const existing = this.app.workspace.getLeavesOfType(SPEAKER_VIEW_TYPE);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: SPEAKER_VIEW_TYPE, active: true });
			this.app.workspace.revealLeaf(leaf);
		}
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

	// -- UI helpers ----------------------------------------------------------

	/** Find the most recent MarkdownView editor, even if a sidebar panel is focused. */
	getMarkdownEditor(): Editor | null {
		// Try active view first
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active) return active.editor;
		// Fall back: iterate all leaves and find one with an editor
		let mdEditor: Editor | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!mdEditor && leaf.view.getViewType() === "markdown") {
				const view = leaf.view as MarkdownView;
				if (view.editor && (view as any).file) {
					mdEditor = view.editor;
				}
			}
		});
		return mdEditor;
	}

	private updateRibbonIcon() {
		if (!this.ribbonIconEl) return;
		if (this.isRecording) {
			setIcon(this.ribbonIconEl, "square");
			this.ribbonIconEl.setAttribute("aria-label", "AI Notetaker: Stop Recording");
			this.ribbonIconEl.addClass("ai-notetaker-recording");
		} else {
			setIcon(this.ribbonIconEl, "mic");
			this.ribbonIconEl.setAttribute("aria-label", "AI Notetaker: Record");
			this.ribbonIconEl.removeClass("ai-notetaker-recording");
		}
	}

	private refreshSpeakerPanel() {
		for (const leaf of this.app.workspace.getLeavesOfType(SPEAKER_VIEW_TYPE)) {
			(leaf.view as SpeakerPanelView).refresh();
		}
	}

	private setStatusBar(text: string) {
		if (this.statusBarItem) {
			this.statusBarItem.setText(text);
		}
	}

	// -- Recording -----------------------------------------------------------

	async startRecording() {
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
		this.updateRibbonIcon();
		this.refreshSpeakerPanel();
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

	stopRecording(editor: Editor) {
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
			this.updateRibbonIcon();
			this.refreshSpeakerPanel();

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

			// Build the transcript text with speaker names
			const transcriptText = this.buildTranscriptText(result.utterances ?? [], speakerMap);

			// Generate Gemini summary if API key is configured
			let geminiOutput = "";
			if (this.settings.geminiApiKey) {
				this.setStatusBar("🤖 Generating notes…");
				try {
					const template = await this.loadSelectedTemplate();
					geminiOutput = await this.callGemini(transcriptText, template);
				} catch (err: any) {
					console.error("AI Notetaker: Gemini error:", err);
					geminiOutput = `> ⚠️ Gemini summarization failed: ${err.message}\n`;
				}
			}

			// Build and insert final markdown
			const markdown = this.buildMarkdown(transcriptText, geminiOutput, speakerMap);
			this.insertIntoEditor(editor, markdown);

			// Store data for deferred "Label Speakers" command
			this.lastUtterances = result.utterances ?? null;
			this.lastFullPcm = fullPcm.length > 0 ? fullPcm : null;
			this.lastEagleScores = eagleScores.length > 0 ? eagleScores : null;
			this.lastEagleProfileNames = eagleProfileNames.length > 0 ? eagleProfileNames : null;

			this.setStatusBar("");

			const hasUnlabeled = result.utterances?.some(
				(u) => !speakerMap?.has(u.speaker),
			);
			if (hasUnlabeled && this.settings.picovoiceAccessKey) {
				new Notice(
					'AI Notetaker: Done! Use "Label Speakers" to name unknown speakers.',
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

	async labelSpeakersInNote(editor: Editor) {
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
					this.refreshSpeakerPanel();
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

	// -- Template loading ----------------------------------------------------

	/** Load the selected prompt template. Returns template string. */
	private async loadSelectedTemplate(): Promise<string> {
		const selected = this.settings.selectedTemplate;
		if (selected === "Default") return DEFAULT_TEMPLATE;

		const folder = this.settings.templateFolder;
		const filePath = `${folder}/${selected}.md`;
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (file && "extension" in file) {
			const content = await this.app.vault.read(file as any);
			if (content.trim()) return content;
		}

		console.warn(`AI Notetaker: Template "${filePath}" not found, using Default.`);
		return DEFAULT_TEMPLATE;
	}

	/** List available template names from the template folder. */
	async listTemplates(): Promise<string[]> {
		const names = ["Default"];
		const folder = this.settings.templateFolder;
		const abstractFolder = this.app.vault.getAbstractFileByPath(folder);
		if (abstractFolder && "children" in abstractFolder) {
			for (const child of (abstractFolder as any).children) {
				if (child.extension === "md") {
					names.push(child.basename);
				}
			}
		}
		return names;
	}

	// -- Gemini integration --------------------------------------------------

	private async callGemini(transcriptText: string, template: string): Promise<string> {
		const prompt = template.includes("{{transcript}}")
			? template.replace("{{transcript}}", transcriptText)
			: template + "\n\n## Transcript:\n" + transcriptText;

		const model = this.settings.geminiModel || "gemini-2.5-flash-lite";
		const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.settings.geminiApiKey}`;

		console.log("AI Notetaker: calling Gemini", model);
		const response = await requestUrl({
			url,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [{ parts: [{ text: prompt }] }],
			}),
		});

		const candidate = response.json?.candidates?.[0];
		if (!candidate) {
			throw new Error("No response from Gemini");
		}

		const text = candidate.content?.parts?.[0]?.text ?? "";
		console.log("AI Notetaker: Gemini response length:", text.length);
		return text;
	}

	// -- Transcript & Markdown builder ---------------------------------------

	/** Build plain-text transcript with speaker names for Gemini input. */
	private buildTranscriptText(
		utterances: AssemblyAIUtterance[],
		speakerMap: Map<string, string> | null,
	): string {
		if (utterances.length === 0) return "No transcript available.";
		return utterances
			.map((u) => {
				const name = speakerMap?.get(u.speaker) ?? `Speaker ${u.speaker}`;
				return `${name}: ${u.text}`;
			})
			.join("\n");
	}

	/** Build final markdown: Gemini notes + raw transcript. */
	private buildMarkdown(
		transcriptText: string,
		geminiOutput: string,
		speakerMap: Map<string, string> | null,
	): string {
		const now = new Date();
		const date = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
		const time = now.toTimeString().slice(0, 5);

		let title = "Meeting Notes";
		let notesBody = geminiOutput.trim();

		// Extract title from Gemini output if it starts with "# "
		if (notesBody.startsWith("# ")) {
			const newlineIdx = notesBody.indexOf("\n");
			if (newlineIdx > 0) {
				title = notesBody.slice(2, newlineIdx).trim();
				notesBody = notesBody.slice(newlineIdx + 1).trim();
			} else {
				title = notesBody.slice(2).trim();
				notesBody = "";
			}
		}

		const lines: string[] = [
			"",
			"---",
			`## ${title}`,
			`*${date} at ${time}*`,
			"",
		];

		if (notesBody) {
			lines.push(notesBody);
		} else if (!geminiOutput) {
			lines.push("*No Gemini API key configured — set one in AI Notetaker settings for AI-generated notes.*");
		}

		lines.push("");
		lines.push("---");
		lines.push("");
		lines.push("### Transcript");
		lines.push("");

		// Raw transcript with speaker labels (markdown bold)
		for (const line of transcriptText.split("\n")) {
			// Convert "Speaker A: text" to "**Speaker A:** text"
			const colonIdx = line.indexOf(": ");
			if (colonIdx > 0) {
				const speaker = line.slice(0, colonIdx);
				const text = line.slice(colonIdx + 2);
				lines.push(`**${speaker}:** ${text}`);
			} else {
				lines.push(line);
			}
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
// Speaker Panel (sidebar view)
// ---------------------------------------------------------------------------

class SpeakerPanelView extends ItemView {
	private plugin: AINotetakerPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: AINotetakerPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return SPEAKER_VIEW_TYPE;
	}

	getDisplayText() {
		return "Speakers";
	}

	getIcon() {
		return "users";
	}

	async onOpen() {
		this.refresh();
	}

	refresh() {
		const container = this.containerEl.children[1];
		container.empty();

		// -- Recording status --
		const statusSection = container.createEl("div", { cls: "ai-notetaker-panel-section" });
		statusSection.style.cssText = "padding:12px;border-bottom:1px solid var(--background-modifier-border);";

		if (this.plugin.isRecording) {
			const statusRow = statusSection.createEl("div");
			statusRow.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:8px;";
			const dot = statusRow.createEl("span");
			dot.style.cssText = "width:10px;height:10px;border-radius:50%;background:#e55;display:inline-block;";
			statusRow.createEl("span", { text: "Recording…" });

			const stopBtn = statusSection.createEl("button", { text: "Stop Recording" });
			stopBtn.style.cssText = "width:100%;";
			stopBtn.addEventListener("click", () => {
				const editor = this.plugin.getMarkdownEditor();
				if (editor) {
					this.plugin.stopRecording(editor);
				} else {
					new Notice("AI Notetaker: Open a note to stop recording into.");
				}
			});
		} else {
			const recBtn = statusSection.createEl("button", { text: "Start Recording" });
			recBtn.addClass("mod-cta");
			recBtn.style.cssText = "width:100%;";
			recBtn.addEventListener("click", () => {
				if (!this.plugin.getMarkdownEditor()) {
					new Notice("AI Notetaker: Open a note first.");
					return;
				}
				this.plugin.startRecording();
			});
		}

		// -- Enrolled speakers --
		const speakerSection = container.createEl("div", { cls: "ai-notetaker-panel-section" });
		speakerSection.style.cssText = "padding:12px;";

		const headerRow = speakerSection.createEl("div");
		headerRow.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;";
		headerRow.createEl("h6", { text: "Enrolled Speakers" }).style.margin = "0";

		const profiles = this.plugin.settings.speakerProfiles;
		const names = Object.keys(profiles);

		if (names.length === 0) {
			speakerSection.createEl("p", {
				text: "No speakers enrolled yet. Record a meeting and use \"Label Speakers\" to enroll.",
				cls: "setting-item-description",
			});
		} else {
			for (const name of names) {
				const row = speakerSection.createEl("div");
				row.style.cssText =
					"display:flex;justify-content:space-between;align-items:center;padding:4px 0;";

				const nameEl = row.createEl("span", { text: name });

				const deleteBtn = row.createEl("button");
				deleteBtn.style.cssText = "padding:2px 6px;font-size:0.8em;";
				setIcon(deleteBtn, "trash-2");
				deleteBtn.setAttribute("aria-label", `Delete ${name}`);
				deleteBtn.addEventListener("click", async () => {
					delete this.plugin.settings.speakerProfiles[name];
					await this.plugin.saveSettings();
					new Notice(`AI Notetaker: Deleted "${name}".`);
					this.refresh();
				});
			}
		}

		// -- Actions --
		const actionSection = container.createEl("div", { cls: "ai-notetaker-panel-section" });
		actionSection.style.cssText = "padding:12px;border-top:1px solid var(--background-modifier-border);";

		const enrollBtn = actionSection.createEl("button", { text: "Enroll Speaker" });
		enrollBtn.style.cssText = "width:100%;margin-bottom:6px;";
		enrollBtn.addEventListener("click", () => {
			new EnrollSpeakerModal(this.plugin.app, this.plugin).open();
		});

		const labelBtn = actionSection.createEl("button", { text: "Label Speakers in Note" });
		labelBtn.style.cssText = "width:100%;";
		labelBtn.addEventListener("click", () => {
			const editor = this.plugin.getMarkdownEditor();
			if (editor) {
				this.plugin.labelSpeakersInNote(editor);
			} else {
				new Notice("AI Notetaker: Open a note first.");
			}
		});
	}

	async onClose() {}
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

		// -- Gemini settings --

		containerEl.createEl("h3", { text: "Gemini (AI Notes)" });

		new Setting(containerEl)
			.setName("Gemini API Key")
			.setDesc(
				createFragment((frag) => {
					frag.appendText("For AI-generated meeting notes. Get one at ");
					frag.createEl("a", {
						text: "aistudio.google.com",
						href: "https://aistudio.google.com/apikey",
					});
					frag.appendText(". Leave blank to skip AI notes.");
				}),
			)
			.addText((text) =>
				text
					.setPlaceholder("your-gemini-api-key")
					.setValue(this.plugin.settings.geminiApiKey)
					.onChange(async (value) => {
						this.plugin.settings.geminiApiKey = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Gemini Model")
			.setDesc("Which Gemini model to use for generating notes.")
			.addDropdown((drop) =>
				drop
					.addOptions({
						"gemini-2.5-flash": "Gemini 2.5 Flash",
						"gemini-2.5-pro": "Gemini 2.5 Pro",
						"gemini-3.1-pro": "Gemini 3.1 Pro",
					})
					.setValue(this.plugin.settings.geminiModel)
					.onChange(async (value) => {
						this.plugin.settings.geminiModel = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Template Folder")
			.setDesc("Vault folder containing prompt template .md files. Templates use {{transcript}} as placeholder.")
			.addText((text) =>
				text
					.setPlaceholder("AI Notetaker Templates")
					.setValue(this.plugin.settings.templateFolder)
					.onChange(async (value) => {
						this.plugin.settings.templateFolder = value;
						await this.plugin.saveSettings();
					}),
			);

		// Template dropdown — populated async
		const templateSetting = new Setting(containerEl)
			.setName("Selected Template")
			.setDesc("Choose which prompt template to use for AI notes generation.");

		this.plugin.listTemplates().then((templates) => {
			templateSetting.addDropdown((drop) => {
				for (const t of templates) {
					drop.addOption(t, t);
				}
				drop.setValue(this.plugin.settings.selectedTemplate);
				drop.onChange(async (value) => {
					this.plugin.settings.selectedTemplate = value;
					await this.plugin.saveSettings();
				});
			});
		});

		// -- Speaker settings --

		containerEl.createEl("h3", { text: "Speaker Recognition" });

		const profileCount = Object.keys(this.plugin.settings.speakerProfiles).length;
		new Setting(containerEl)
			.setName("Speaker Profiles")
			.setDesc(
				`${profileCount} speaker(s) enrolled. Use the "Manage Speaker Profiles" command to view or remove.`,
			);
	}
}

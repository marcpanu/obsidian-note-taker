import { Plugin, PluginSettingTab, Setting, Notice, MarkdownView, Editor } from "obsidian";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AINotetakerSettings {
	assemblyAiApiKey: string;
}

const DEFAULT_SETTINGS: AINotetakerSettings = {
	assemblyAiApiKey: "",
};

interface AssemblyAIUtterance {
	speaker: string;
	text: string;
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

		this.addSettingTab(new AINotetakerSettingTab(this.app, this));
	}

	onunload() {
		if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
			this.mediaRecorder.stop();
		}
		this.setStatusBar("");
	}

	// -- Settings helpers ----------------------------------------------------

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
			new Notice("AI Notetaker: Microphone access denied. Please allow microphone permissions.");
			return;
		}

		this.audioChunks = [];

		// Prefer webm/opus, fall back to whatever the browser supports
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

		this.mediaRecorder.start(1000); // collect data every second
		this.isRecording = true;
		this.setStatusBar("🔴 Recording…");
		new Notice("AI Notetaker: Recording started.");
	}

	private stopRecording(editor: Editor) {
		if (!this.mediaRecorder) return;

		this.mediaRecorder.onstop = async () => {
			// Stop all mic tracks so the OS indicator goes away
			this.mediaRecorder?.stream.getTracks().forEach((t) => t.stop());

			const audioBlob = new Blob(this.audioChunks, {
				type: this.mediaRecorder?.mimeType ?? "audio/webm",
			});
			this.audioChunks = [];
			this.isRecording = false;

			await this.transcribeAndInsert(audioBlob, editor);
		};

		this.mediaRecorder.stop();
		this.setStatusBar("⏳ Transcribing…");
		new Notice("AI Notetaker: Recording stopped. Transcribing…");
	}

	// -- AssemblyAI integration ----------------------------------------------

	private async transcribeAndInsert(audioBlob: Blob, editor: Editor) {
		const apiKey = this.settings.assemblyAiApiKey;

		try {
			// 1. Upload audio
			const uploadUrl = await this.uploadAudio(audioBlob, apiKey);

			// 2. Submit transcription job
			const transcriptId = await this.submitTranscription(uploadUrl, apiKey);

			// 3. Poll until complete
			const result = await this.pollTranscription(transcriptId, apiKey);

			// 4. Build Markdown and insert
			const markdown = this.buildMarkdown(result);
			this.insertIntoEditor(editor, markdown);

			this.setStatusBar("");
			new Notice("AI Notetaker: Transcription complete!");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const errorBlock = `\n> ⚠️ Transcription failed: ${message}\n`;
			this.insertIntoEditor(editor, errorBlock);
			this.setStatusBar("");
			new Notice(`AI Notetaker: Transcription failed — ${message}`);
		}
	}

	private async uploadAudio(blob: Blob, apiKey: string): Promise<string> {
		const response = await fetch("https://api.assemblyai.com/v1/upload", {
			method: "POST",
			headers: {
				authorization: apiKey,
				"Content-Type": "application/octet-stream",
			},
			body: blob,
		});

		if (!response.ok) {
			throw new Error(`Audio upload failed (HTTP ${response.status})`);
		}

		const data = await response.json();
		return data.upload_url;
	}

	private async submitTranscription(audioUrl: string, apiKey: string): Promise<string> {
		const response = await fetch("https://api.assemblyai.com/v2/transcript", {
			method: "POST",
			headers: {
				authorization: apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				audio_url: audioUrl,
				speaker_labels: true,
				summarization: true,
				summary_model: "informative",
				summary_type: "bullets",
				auto_highlights: true,
			}),
		});

		if (!response.ok) {
			throw new Error(`Transcript submission failed (HTTP ${response.status})`);
		}

		const data = await response.json();
		return data.id;
	}

	private async pollTranscription(
		transcriptId: string,
		apiKey: string,
	): Promise<AssemblyAITranscriptResponse> {
		const url = `https://api.assemblyai.com/v2/transcript/${transcriptId}`;

		while (true) {
			const response = await fetch(url, {
				headers: { authorization: apiKey },
			});

			if (!response.ok) {
				throw new Error(`Polling failed (HTTP ${response.status})`);
			}

			const data: AssemblyAITranscriptResponse = await response.json();

			if (data.status === "completed") {
				return data;
			}

			if (data.status === "error") {
				throw new Error(data.error ?? "Unknown transcription error");
			}

			// Wait 3 seconds before next poll
			await this.sleep(3000);
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	// -- Markdown builder ----------------------------------------------------

	private buildMarkdown(result: AssemblyAITranscriptResponse): string {
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

		// Summary bullets
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

		// Action items from auto_highlights
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

		// Speaker-labeled utterances
		if (result.utterances && result.utterances.length > 0) {
			for (const u of result.utterances) {
				lines.push(`**${u.speaker}:** ${u.text}`);
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

	// -- Editor insertion ----------------------------------------------------

	private insertIntoEditor(editor: Editor, text: string) {
		const cursor = editor.getCursor();
		editor.replaceRange(text, cursor);
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
	}
}

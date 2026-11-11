declare module "@met4citizen/headtts" {
  export type HeadTTSMessage = {
    type: "audio" | "error" | "custom";
    data?: {
      audio?: AudioBuffer;
      audioEncoding?: "wav" | "pcm";
      words?: string[];
      wtimes?: number[];
      wdurations?: number[];
      error?: string;
    };
  };

  export class HeadTTS {
    constructor(settings?: Record<string, unknown>);
    connect(
      settings?: Record<string, unknown> | null,
      onprogress?: ((event: ProgressEvent) => void) | null,
      onerror?: ((event: Event) => void) | null
    ): Promise<void>;
    setup(data: Record<string, unknown>): Promise<unknown>;
    synthesize(data: { input: string }): Promise<HeadTTSMessage[]>;
    clear(): void;
  }
}
